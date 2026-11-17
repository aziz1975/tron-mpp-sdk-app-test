import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addressesForDisplay, jsonForDisplay, responseTextForDisplay } from '../src/display.js'

const payer = '0xE57Ea93173DeA454EfF302E48E58DbA4F942dDBb'
const escrow = '0x2Ae718942e8ae094DAA8395955497F5835187c1B'
const permit2 = '0xf62f506D1FaA02e2354a9886B4A200496EE96F4b'
const payer58 = 'TWtfUYRLfA4b61eJ3wwHmYcieV14rUTMCW'
const escrow58 = 'TDt4Dwx56E2wqQUgSXonQrwebxNiXPvT8F'
const permit258 = 'TYQuuhGbEMxF7nZxUHV3uHJxAVVAegNU9h'

test('console output converts nested session and challenge addresses without mutating protocol data', () => {
  const hash = `0x${'ab'.repeat(32)}`, signature = `0x${'cd'.repeat(65)}`
  const receipt = 'encoded-payment-receipt'
  const input = {
    payer, escrow, permit2, channel: { payer, payee: payer, token: permit2, authorizedSigner: payer },
    request: { currency: permit2, recipient: payer, methodDetails: { escrowContract: escrow, permit2Contract: permit2 } },
    body: JSON.stringify({ currency: permit2, recipient: payer, signature }),
    channelId: hash, hash, nonce: hash, signature, receipt, id: payer,
  }
  const snapshot = JSON.stringify(input)
  const output = JSON.parse(jsonForDisplay(input)!)
  assert.deepEqual([output.payer, output.escrow, output.permit2], [payer58, escrow58, permit258])
  assert.deepEqual(output.channel, { payer: payer58, payee: payer58, token: permit258, authorizedSigner: payer58 })
  assert.equal(output.request.currency, permit258)
  assert.equal(output.request.recipient, payer58)
  assert.deepEqual(output.request.methodDetails, { escrowContract: escrow58, permit2Contract: permit258 })
  assert.deepEqual(JSON.parse(output.body), { currency: permit258, recipient: payer58, signature })
  assert.deepEqual([output.channelId, output.hash, output.nonce, output.signature, output.receipt, output.id], [hash, hash, hash, signature, receipt, payer])
  assert.equal(JSON.stringify(input), snapshot)
})

test('console output handles address arrays and TRON hex fields while preserving existing Base58', () => {
  assert.deepEqual(addressesForDisplay({
    recipients: [payer, payer58], escrowContracts: [escrow],
    tokenAddress: permit2, owner_address: `41${payer.slice(2)}`, verifyingContract: escrow,
  }), {
    recipients: [payer58, payer58], escrowContracts: [escrow58],
    tokenAddress: permit258, owner_address: payer58, verifyingContract: escrow58,
  })
})

test('display formatting leaves native currency, invalid addresses and non-JSON response text intact', () => {
  assert.deepEqual(addressesForDisplay({ currency: 'TRX', recipient: 'invalid' }), { currency: 'TRX', recipient: 'invalid' })
  assert.equal(responseTextForDisplay('Request unavailable'), 'Request unavailable')
  assert.deepEqual(JSON.parse(responseTextForDisplay(JSON.stringify({ currency: permit2 }))), { currency: permit258 })
})
