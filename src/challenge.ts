import assert from 'node:assert/strict'
import { Challenge } from 'mppx'
import { Charge, normalizeAddress } from 'tron-mpp-sdk'
import { loadSharedConfig } from './config.js'

const config = loadSharedConfig()
const response = await fetch(`http://127.0.0.1:${config.port}/premium`)
assert.equal(response.status, 402, 'Expected HTTP 402 from /premium.')
const challenge = Challenge.fromResponse(response)
const request = Charge.RequestSchema.parse(challenge.request)
assert.equal(challenge.method, 'tron')
assert.equal(challenge.intent, 'charge')
assert.equal(request.methodDetails.chainId, config.chainId)
assert.equal(normalizeAddress(request.currency), config.tokenAddress)
assert.equal(normalizeAddress(request.recipient), config.recipientAddress)
assert.deepEqual(request.methodDetails.credentialTypes, [config.credentialType], 'Restart the server after changing CHARGE_CREDENTIAL_TYPE.')
if (config.permit2) {
  assert.equal(normalizeAddress(request.methodDetails.permit2Address ?? ''), config.permit2.address)
  assert.equal(normalizeAddress(request.methodDetails.spender ?? ''), config.permit2.spender)
}
console.log(JSON.stringify(challenge, null, 2))
console.log('Challenge inspected. No credential was signed or submitted.')
