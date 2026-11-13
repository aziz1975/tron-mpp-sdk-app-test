import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionTestClient } from '../src/session-payment-client.js'
import { acquireLock, fileStore, readJson } from '../src/session-storage.js'
import { loadSessionClientConfig, loadSessionServerConfig } from '../src/session-config.js'
import { sessionFixture, escrow, permit2 } from './session-helpers.js'
import { key, token, recipient } from './helpers.js'
import { TransactionNotSubmittedError } from 'tron-mpp-sdk'

test('Permit2 session lifecycle, HEAD vouchers, streamed receipts, settlement and close/refund', async t => {
  const f = await sessionFixture(); t.after(f.close)
  const challenge = await f.client.challenge()
  assert.equal(challenge.intent, 'session')
  assert.equal(challenge.request.amount, '10')
  const opened = await f.client.execute('open')
  assert.equal(opened.status, 200)
  assert.equal(f.counters.funding, 1)
  assert.equal((await f.manager.state(f.client.channelId!))!.spent, '0')
  assert.equal((await f.client.execute('voucher')).status, 200)
  assert.equal((await f.manager.state(f.client.channelId!))!.spent, '0')
  assert.equal((await f.client.replay()).status, 200) // HEAD is idempotent and unbilled.
  assert.equal((await f.client.execute('pay')).status, 200)
  assert.equal((await f.client.replay()).status, 409) // Paid request nonce is single-use.
  const streamed = await f.client.execute('stream')
  assert.equal(streamed.status, 200)
  assert.equal((streamed.body.match(/event: content/g) ?? []).length, 3)
  assert.match(streamed.body, /event: payment-need-voucher/)
  assert.match(streamed.body, /"requiredCumulative":"50"/)
  assert.match(streamed.body, /event: payment-receipt/)
  assert.equal((streamed.receipt as Record<string, unknown>).spent, '40')
  assert.equal((await f.client.execute('merge')).status, 200)
  assert.equal(f.counters.funding, 2)
  assert.equal((await f.manager.state(f.client.channelId!))!.deposit, '200')
  assert.equal((await f.manager.state(f.client.channelId!))!.spent, '40')
  assert.equal((await f.client.operator('settle', 'wrong-secret')).status, 401)
  assert.equal(f.counters.settle, 0)
  assert.equal((await f.client.operator('settle', f.serverConfig.mppSecretKey)).status, 200)
  assert.equal(f.counters.settle, 1)
  assert.equal((await f.client.execute('pay')).status, 200) // Settled prepaid credit still pays for service.
  assert.equal((await f.client.execute('close')).status, 200)
  assert.equal((await f.manager.state(f.client.channelId!))!.closed, true)
  assert.deepEqual(f.balances(), { payer: 920n, merchant: 80n, escrow: 0n, allowance: 0n })
  assert.equal(f.counters.close, 1)
})

test('pending Permit2 funding survives client/server restart and retries without another submission', async t => {
  const f = await sessionFixture(); t.after(f.close)
  f.flags.pending = true
  assert.equal((await f.client.execute('open')).status, 503)
  assert.equal(f.client.pending, true)
  assert.equal(f.counters.funding, 1)
  await assert.rejects(f.client.execute('open'), /unresolved/)
  await f.restart()
  f.flags.pending = false
  const resumed = new SessionTestClient(f.config, f.transport)
  assert.equal(resumed.pending, true)
  const signatures = f.counters.signatures
  assert.equal((await resumed.retry()).status, 200)
  assert.equal(f.counters.funding, 1)
  assert.equal(f.counters.signatures, signatures)
  assert.equal(resumed.pending, false)
})

test('standalone Permit2 top-ups preserve forced close and withdrawal waits for the grace period', async t => {
  const f = await sessionFixture(); t.after(f.close)
  await f.client.execute('open')
  const id = f.client.channelId!
  await f.client.force('requestClose')
  const requested = f.channels.get(id)!.closeRequestedAt
  assert.equal((await f.client.execute('topUp')).status, 200)
  assert.equal(f.channels.get(id)!.closeRequestedAt, requested)
  const sent = f.counters.payerSends
  await assert.rejects(f.client.force('withdraw'), /Grace period/)
  assert.equal(f.counters.payerSends, sent)
  assert.equal(f.client.pending, false)
  await assert.rejects(f.client.execute('voucher'), /channel unavailable/i)
  f.flags.now += 900n
  await f.client.force('withdraw')
  assert.equal((await f.client.operator('reconcile', f.serverConfig.mppSecretKey)).status, 200)
  // The built-in adapter has no confirmed channel snapshot for external withdrawals.
  assert.equal((await f.manager.state(id))!.closed, false)
  assert.equal(f.balances().payer, 1000n)
  assert.equal(f.balances().escrow, 0n)
})

test('session replay protection and billing remain durable after restarting both sides', async t => {
  const f = await sessionFixture(); t.after(f.close)
  await f.client.execute('open'); await f.client.execute('voucher', '20'); await f.client.execute('pay')
  await f.restart()
  const resumed = new SessionTestClient(f.config, f.transport)
  assert.equal((await resumed.replay()).status, 409)
  assert.equal((await f.manager.state(resumed.channelId!))!.spent, '10')
  assert.equal((await resumed.execute('pay')).status, 200)
  assert.equal((await f.manager.state(resumed.channelId!))!.spent, '20')
  const exhausted = await resumed.execute('pay')
  assert.equal(exhausted.status, 402)
  assert.equal(resumed.pending, false)
  assert.equal((await f.manager.state(resumed.channelId!))!.spent, '20')
})

test('client checks session recipient, escrow, Permit2 and price before signing', async t => {
  const f = await sessionFixture(); t.after(f.close)
  for (const change of [{ recipientAddress: token }, { escrowAddress: token }, { permit2Address: token }, { unitAmount: '11' }]) {
    const client = new SessionTestClient({ ...f.config, ...change }, f.transport)
    await assert.rejects(client.execute('open'), /local policy/)
  }
  assert.equal(f.counters.signatures, 0)
  assert.equal(f.counters.funding, 0)
})

test('deposit and voucher limits reject before another funding or signature', async t => {
  const f = await sessionFixture(); t.after(f.close)
  await f.client.execute('open')
  const limited = new SessionTestClient({ ...f.config, maxCumulative: '19', maxDeposit: '101' }, f.transport)
  const signed = f.counters.signatures
  await assert.rejects(limited.execute('voucher', '20'), /cap/)
  await assert.rejects(limited.execute('topUp'), /MAX_DEPOSIT/)
  assert.equal(f.counters.funding, 1)
  assert.equal(f.counters.signatures, signed)
})

test('session approval and revocation target Permit2 and the explicit funding cap', async t => {
  const f = await sessionFixture(); t.after(f.close)
  assert.deepEqual(await f.client.approve(), { unchanged: true, allowance: '200' })
  await f.client.approve(true)
  assert.equal(f.balances().allowance, 0n)
  await f.client.approve()
  assert.equal(f.balances().allowance, 200n)
  assert.equal(f.balances().payer, 1000n)
  assert.equal(f.counters.payerSends, 2)
})

test('uncertain close reconciles without another close transaction and permits a fresh channel', async t => {
  const f = await sessionFixture(); t.after(f.close)
  await f.client.execute('open'); await f.client.execute('voucher', '20'); await f.client.execute('pay')
  const original = f.client.channelId
  f.flags.pending = true
  assert.equal((await f.client.execute('close')).status, 503)
  assert.equal(f.client.pending, true)
  assert.equal(f.counters.close, 1)
  assert.equal((await f.client.operator('reconcile', f.serverConfig.mppSecretKey)).status, 200)
  assert.equal(f.client.pending, true)
  assert.equal((await f.manager.state(original!))!.closed, false)
  f.flags.pending = false
  assert.equal((await f.client.operator('reconcile', f.serverConfig.mppSecretKey)).status, 200)
  assert.equal(f.client.pending, false)
  assert.equal((await f.manager.state(original!))!.closed, true)
  assert.equal(f.counters.close, 1)
  assert.equal((await f.client.execute('open')).status, 200)
  assert.notEqual(f.client.channelId, original)
  assert.equal(f.counters.funding, 2)
})

test('uncertain payer approval is confirmed from the saved hash without resubmission', async t => {
  const f = await sessionFixture(); t.after(f.close)
  f.flags.pending = true
  await assert.rejects(f.client.approve(true), /unknown/)
  assert.equal(f.client.pending, true)
  const resumed = new SessionTestClient(f.config, f.transport)
  f.flags.pending = false
  assert.equal((await resumed.retry()).status, 200)
  assert.equal(resumed.pending, false)
  assert.equal(f.counters.payerSends, 1)
  assert.equal(f.balances().allowance, 0n)
})

test('a provably unsubmitted payer transaction releases its local reservation', async t => {
  const f = await sessionFixture(); t.after(f.close)
  f.transport.send = async () => { throw new TransactionNotSubmittedError() }
  await assert.rejects(f.client.approve(true), /not submitted/)
  assert.equal(f.client.pending, false)
  assert.equal(f.counters.payerSends, 0)
})

test('single-process file store serializes debits and fails closed on corrupted data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-store-test-')), path = join(dir, 'server.json')
  const store = fileStore(path)
  await store.put('counter', 0)
  await Promise.all(Array.from({ length: 25 }, () => store.update('counter', current => ({ op: 'set', value: Number(current) + 1, result: undefined }))))
  assert.equal(await fileStore(path).get('counter'), 25)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const release = acquireLock(join(dir, 'server.lock'))
  assert.throws(() => acquireLock(join(dir, 'server.lock')), /Another process/)
  release()
  const second = acquireLock(join(dir, 'server.lock')); second()
  writeFileSync(path, '{corrupt')
  assert.throws(() => fileStore(path))
  assert.equal(readFileSync(path, 'utf8'), '{corrupt')
})

test('session configuration validates credential mode and merchant signing', () => {
  const previous = process.env
  try {
    process.env = { TRON_TOKEN_ADDRESS: token, TRON_RECIPIENT_ADDRESS: recipient, TRON_PERMIT2_ADDRESS: permit2,
      TRON_SESSION_ESCROW_ADDRESS: escrow, TRON_PAYER_PRIVATE_KEY: key, TRON_RELAYER_PRIVATE_KEY: '2'.repeat(64), MPP_SECRET_KEY: 'session-config-test-secret', CREDENTIAL_TYPE: 'permit2' }
    assert.equal(loadSessionClientConfig().credentialType, 'permit2')
    process.env.CREDENTIAL_TYPE = 'transaction'
    assert.throws(loadSessionClientConfig, /CREDENTIAL_TYPE must be permit2/)
    process.env.CREDENTIAL_TYPE = 'authorization'
    assert.throws(loadSessionServerConfig, /CREDENTIAL_TYPE must be permit2/)
    process.env.CREDENTIAL_TYPE = 'permit2'
    assert.equal(loadSessionClientConfig().escrowAddress, escrow)
    assert.throws(loadSessionServerConfig, /TRON_PAYEE_PRIVATE_KEY/)
    process.env.TRON_PAYEE_PRIVATE_KEY = '3'.repeat(64)
    assert.equal(loadSessionServerConfig().payeePrivateKey, '3'.repeat(64))
    delete process.env.TRON_PAYER_PRIVATE_KEY
    assert.equal(loadSessionServerConfig().port, 3001)
    process.env.SESSION_MAX_CUMULATIVE_ATOMIC = '0'
    assert.throws(loadSessionServerConfig, /positive/)
    delete process.env.SESSION_MAX_CUMULATIVE_ATOMIC
    delete process.env.TRON_SESSION_ESCROW_ADDRESS
    assert.throws(loadSessionServerConfig, /TRON_SESSION_ESCROW_ADDRESS/)
  } finally { process.env = previous }
})
