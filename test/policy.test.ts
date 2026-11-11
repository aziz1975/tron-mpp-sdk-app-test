import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPaymentClientMethod } from '../src/payment-client.js'
import { loadServerConfig, loadClientConfig } from '../src/config.js'
import { clientConfig, fixture, simulatedTransport, token, recipient, key, chainId } from './helpers.js'

test('atomic spending cap rejects before wallet signing', async t => {
  const f = await fixture({ amount: '1000001' }); t.after(f.close)
  await assert.rejects(f.method.createCredential({ challenge: await f.challenge() }), /maxAtomicAmount/)
  assert.equal(f.counters.signatures, 0); assert.equal(f.counters.broadcasts, 0)
})
test('wrong transport chain rejects before wallet signing', async t => {
  const f = await fixture({ clientChainId: 728126428 }); t.after(f.close)
  await assert.rejects(f.method.createCredential({ challenge: await f.challenge() }), /chain/)
  assert.equal(f.counters.signatures, 0)
})
for (const variant of ['TRX', 'token', 'recipient', 'amount', 'chain', 'expired'] as const) {
  test(`client policy rejects ${variant} before wallet signing`, async () => {
    const sim = simulatedTransport(), { method } = createPaymentClientMethod(clientConfig(), sim.transport)
    const c = { id: 'policy', realm: 'localhost', method: 'tron' as const, intent: 'charge' as const,
      expires: new Date(Date.now() + 60000).toISOString(), request: {
        amount: variant === 'amount' ? '1000001' : '1000000', currency: variant === 'TRX' ? 'TRX' : variant === 'token' ? recipient : token,
        recipient: variant === 'recipient' ? token : recipient,
        methodDetails: { chainId: variant === 'chain' ? 728126428 : chainId, credentialTypes: ['transaction'] as ['transaction'] },
      } }
    if (variant === 'expired') c.expires = new Date(Date.now() - 1).toISOString()
    // Exercise malformed remote JSON at the SDK boundary, including native TRX.
    await assert.rejects(method.createCredential({ challenge: c as Parameters<typeof method.createCredential>[0]['challenge'] }))
    assert.equal(sim.counters.signatures, 0); assert.equal(sim.counters.broadcasts, 0)
  })
}
test('configuration requires a token and rejects native configuration, invalid atomic amounts and ports', () => {
  const original = process.env
  try {
    process.env = { MPP_SECRET_KEY: 'local-config-test-secret', TRON_TOKEN_ADDRESS: token, TRON_RECIPIENT_ADDRESS: recipient, TRON_PAYER_PRIVATE_KEY: key }
    assert.equal(loadServerConfig().paymentAmountAtomic, '1000000')
    assert.equal(loadClientConfig().maxAtomicAmount, '1000000')
    for (const bad of ['', 'TRX', `0x${'0'.repeat(40)}`]) {
      process.env.TRON_TOKEN_ADDRESS = bad
      assert.throws(loadServerConfig, /TRON_TOKEN_ADDRESS/)
      assert.throws(loadClientConfig, /TRON_TOKEN_ADDRESS/)
    }
    process.env.TRON_TOKEN_ADDRESS = token
    process.env.PAYMENT_AMOUNT_TRX = '0.000001'
    assert.throws(loadServerConfig, /no longer supported/)
    delete process.env.PAYMENT_AMOUNT_TRX
    for (const amount of ['0', '-1', '1.25', '1e6', '01', (1n << 256n).toString()]) {
      process.env.PAYMENT_AMOUNT_ATOMIC = amount
      assert.throws(loadServerConfig, /PAYMENT_AMOUNT_ATOMIC/)
    }
    delete process.env.PAYMENT_AMOUNT_ATOMIC
    for (const port of ['0', '-1', '1.2', '65536']) {
      process.env.PORT = port
      assert.throws(loadServerConfig, /PORT/)
      assert.throws(loadClientConfig, /PORT/)
    }
  } finally { process.env = original }
})
