import { createServer } from 'node:http'
import { Mppx, Store, tron } from 'tron-mpp-sdk/server'
import { createChargeAdapter, createTronWebTransport, type TronTransport } from 'tron-mpp-sdk/tronweb'
import type { ServerConfig } from './config.js'
import { createTronWeb } from './tron.js'

export function createAppServer(config: ServerConfig, transport: TronTransport = createTronWebTransport(createTronWeb({ ...config, privateKey: config.relayerPrivateKey }), { chainId: config.chainId })) {
  const adapter = createChargeAdapter(transport, {
    timeoutMs: config.transactionTimeoutMs, pollIntervalMs: config.pollIntervalMs, minConfirmations: config.minConfirmations,
  })
  const payment = Mppx.create({ secretKey: config.mppSecretKey, methods: [tron.charge({
    adapter, chainId: config.chainId, currency: config.tokenAddress, recipient: config.recipientAddress,
    credentialTypes: [config.credentialType], ...(config.permit2 ? { permit2: config.permit2 } : {}), store: Store.memory(),
  })] })
  const paidRoute = Mppx.toNodeListener(payment.charge({
    amount: config.paymentAmountAtomic, description: 'TRC-20 charge integration test',
  }))
  return createServer(async (request, response) => {
    const startedAt = performance.now()
    const hasAuthorization = Boolean(request.headers.authorization)
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      response.once('finish', () => {
        console.log(`${new Date().toISOString()} ${request.method ?? 'UNKNOWN'} ${url.pathname} -> ${response.statusCode}` +
          ` authorization=${hasAuthorization ? 'present' : 'absent'}` +
          ` receipt=${response.hasHeader('payment-receipt') ? 'present' : 'absent'}` +
          ` durationMs=${Math.round(performance.now() - startedAt)}`)
      })
      if (request.method === 'GET' && url.pathname === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ status: 'ok', network: 'nile', chainId: config.chainId, currency: config.tokenAddress,
          credentialType: config.credentialType, ...(config.permit2 ? { permit2: config.permit2 } : {}) }))
        return
      }
      if (request.method !== 'GET' || url.pathname !== '/premium') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'Not found' }))
        return
      }
      const result = await paidRoute(request, response)
      if (result.status !== 200) return
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        message: 'TRC-20 payment verified. Premium content unlocked.', network: 'nile', currency: config.tokenAddress,
        paymentReceiptAttached: response.hasHeader('payment-receipt'),
      }))
    } catch (error) {
      console.error(error)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      if (!response.writableEnded) response.end(JSON.stringify({ error: 'Internal server error' }))
    }
  })
}
