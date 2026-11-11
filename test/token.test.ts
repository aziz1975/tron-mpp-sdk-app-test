import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Credential } from 'mppx'
import { signedTransaction, fixture, transferData, token, recipient } from './helpers.js'

for (const variant of ['wrong token', 'wrong recipient', 'wrong amount', 'native value', 'tampered envelope'] as const) {
  test(`signed transaction rejects ${variant} before broadcasting`, async t => {
    const f = await fixture(); t.after(f.close)
    const c = await f.challenge()
    let signature = await signedTransaction(variant === 'wrong token' ? recipient : token,
      transferData(variant === 'wrong recipient' ? token : recipient, variant === 'wrong amount' ? 1n : 1000000n), 1, variant === 'native value' ? 1 : 0)
    if (variant === 'tampered envelope') {
      const changed = JSON.parse(signature)
      changed.raw_data.contract[0].parameter.value.data = transferData(token).slice(2)
      signature = JSON.stringify(changed)
    }
    const header = Credential.serialize(Credential.from({ challenge: c, payload: { type: 'transaction', signature } }))
    assert.equal((await f.submit(header)).status, 402)
    assert.equal(f.counters.broadcasts, 0)
  })
}
