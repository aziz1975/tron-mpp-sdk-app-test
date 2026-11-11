import { Challenge, Receipt } from 'mppx'

import { createPaymentClientMethod } from './payment-client.js'

const { config, method } = createPaymentClientMethod()
const endpoint = `${config.serverUrl}/premium`
const challengeResponse = await fetch(endpoint)

if (challengeResponse.status !== 402) {
  throw new Error(`Expected an initial 402 response, received ${challengeResponse.status}.`)
}

const challenge = Challenge.fromResponse(challengeResponse, { methods: [method] })
const authorization = await method.createCredential({ challenge })
const headers = { authorization }

const acceptedResponse = await fetch(endpoint, { headers })
console.log(`First submission: ${acceptedResponse.status}`)
console.log('First response:', await acceptedResponse.text())

if (acceptedResponse.status !== 200) {
  throw new Error('The first credential submission was not accepted.')
}
console.log(`Confirmed TRC-20 transaction: ${Receipt.fromResponse(acceptedResponse).reference}`)

const replayResponse = await fetch(endpoint, { headers })
console.log(`Replay submission: ${replayResponse.status}`)
console.log('Replay response:', await replayResponse.text())

if (replayResponse.status !== 402) {
  throw new Error(`Expected replay rejection with HTTP 402, received ${replayResponse.status}.`)
}
