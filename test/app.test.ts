import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Credential, Receipt } from 'mppx'
import { Mppx } from 'tron-mpp-sdk/client'
import { normalizeAddress } from 'tron-mpp-sdk'
import { fixture, token, recipient, chainId } from './helpers.js'

test('TRC-20 charge app HTTP integration', async t => {
  const f = await fixture(); t.after(f.close)
  await t.test('health, routing and atomic token challenge', async () => {
    assert.deepEqual(await (await fetch(`${f.url}/health`)).json(), { status: 'ok', network: 'nile', chainId, currency: token, credentialType: 'transaction' })
    for (const [path, method] of [['/missing', 'GET'], ['/premium', 'POST'], ['/health', 'POST']] as const) {
      assert.equal((await fetch(`${f.url}${path}`, { method })).status, 404)
    }
    const c = await f.challenge()
    assert.equal(c.request.amount, '1000000')
    assert.equal(normalizeAddress(c.request.currency), token)
    assert.equal(normalizeAddress(c.request.recipient), recipient)
    assert.equal(c.request.methodDetails.chainId, chainId)
    assert.deepEqual(c.request.methodDetails.credentialTypes, ['transaction'])
    assert(!('asset' in c.request.methodDetails))
  })
  await t.test('client signs without broadcasting; server submits once and returns a receipt', async () => {
    const before = f.counters.broadcasts
    const header = await f.method.createCredential({ challenge: await f.challenge() })
    assert.equal(f.counters.broadcasts, before)
    assert.equal((Credential.deserialize(header).payload as { type: string }).type, 'transaction')
    const response = await f.submit(header)
    assert.equal(response.status, 200)
    assert.equal(f.counters.broadcasts, before + 1)
    assert.equal((await response.json()).paymentReceiptAttached, true)
    const receipt = Receipt.fromResponse(response)
    assert.equal(receipt.status, 'success')
    assert.equal(receipt.method, 'tron')
    assert.match(receipt.reference, /^0x[0-9a-f]{64}$/)
  })
  await t.test('automatic 402 -> signed transfer -> paid fetch', async () => {
    const client = Mppx.create({ methods: [f.method], polyfill: false })
    const response = await client.fetch(`${f.url}/premium`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).currency, token)
    assert(response.headers.has('Payment-Receipt'))
  })
  await t.test('sequential and concurrent credential replay never deliver twice', async () => {
    for (const concurrent of [false, true]) {
      const header = await f.method.createCredential({ challenge: await f.challenge() })
      const before = f.counters.broadcasts
      const responses = concurrent ? await Promise.all([f.submit(header), f.submit(header)]) : [await f.submit(header), await f.submit(header)]
      assert.equal(responses.filter(r => r.status === 200).length, 1)
      for (const response of responses) assert([200, 402, 503].includes(response.status))
      // A concurrent loser may see an in-flight 503; once settled it is a definitive replay.
      assert.equal((await f.submit(header)).status, 402)
      assert.equal(f.counters.broadcasts, before + 1)
    }
  })
  await t.test('changed challenge terms and source reject before broadcasting', async () => {
    for (const mutation of ['amount', 'recipient', 'token', 'source', 'challenge']) {
      const header = await f.method.createCredential({ challenge: await f.challenge() })
      const changed = Credential.deserialize(header)
      if (mutation === 'amount') changed.challenge.request.amount = '2'
      if (mutation === 'recipient') changed.challenge.request.recipient = token
      if (mutation === 'token') changed.challenge.request.currency = recipient
      if (mutation === 'source') changed.source = `did:pkh:tron:${chainId}:${recipient}`
      if (mutation === 'challenge') changed.challenge.id += 'tampered'
      const before = f.counters.broadcasts
      assert.equal((await f.submit(Credential.serialize(changed))).status, 402)
      assert.equal(f.counters.broadcasts, before)
      assert.equal((await f.submit(header)).status, 200)
    }
  })
  for (const condition of ['pending', 'rpcFailure', 'confirmations'] as const) {
    await t.test(`recovers ${condition} without broadcasting a second payment`, async () => {
      const header = await f.method.createCredential({ challenge: await f.challenge() })
      if (condition === 'confirmations') f.flags.currentBlock = 98
      else f.flags[condition] = true
      const before = f.counters.broadcasts
      const response = await f.submit(header)
      assert.equal(response.status, 503)
      assert(!response.headers.has('Payment-Receipt'))
      if (condition === 'confirmations') f.flags.currentBlock = 100
      else f.flags[condition] = false
      assert.equal((await f.submit(header)).status, 200)
      assert.equal(f.counters.broadcasts, before + 1)
    })
  }
  for (const condition of ['failed', 'wrongAmount', 'wrongRecipient', 'wrongPayer', 'wrongToken', 'missingLog'] as const) {
    await t.test(`rejects definitive ${condition} evidence`, async () => {
      const header = await f.method.createCredential({ challenge: await f.challenge() })
      f.flags[condition] = true
      const response = await f.submit(header)
      assert.equal(response.status, 402)
      assert(!response.headers.has('Payment-Receipt'))
      f.flags[condition] = false
      assert.equal((await f.submit(header)).status, 402)
    })
  }
})
