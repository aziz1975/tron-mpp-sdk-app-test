import { Mppx } from 'tron-mpp-sdk/client'
import { Receipt } from 'mppx'

import { createPaymentClientMethod } from './payment-client.js'

const { config, method } = createPaymentClientMethod()
console.log(`Charge credential: ${config.credentialType}`)
const { fetch: paymentFetch } = Mppx.create({ methods: [method], polyfill: false })

const response = await paymentFetch(`${config.serverUrl}/premium`)
const body: unknown = await response.json()

console.log(`HTTP status: ${response.status}`)
console.log(`Payment-Receipt: ${response.headers.get('payment-receipt') ?? 'missing'}`)
console.log('Response:', body)

if (response.ok && response.headers.has('payment-receipt')) {
  console.log(`Confirmed TRC-20 transaction: ${Receipt.fromResponse(response).reference}`)
}

if (!response.ok) process.exitCode = 1
