import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { Credential, Receipt, type Store } from 'mppx'
import { Bytes32Schema, Session } from 'tron-mpp-sdk'
import { Mppx, tron, needVoucherEvent, receiptEvent, type SessionState } from 'tron-mpp-sdk/server'
import { acquireLock, fileStore } from './session-storage.js'
import { inspectEscrow, nodeTransport, serverAdapter } from './session-chain.js'
import type { SessionServerConfig } from './session-config.js'

export function publicState(state: SessionState | null) {
  if (!state) return null
  return { deposit: state.deposit, acceptedCumulative: state.acceptedCumulative, spent: state.spent,
    settledOnChain: state.settledOnChain, closed: state.closed, closing: state.closing,
    available: (BigInt(state.acceptedCumulative) - BigInt(state.spent)).toString(),
    ...(state.txHash ? { txHash: state.txHash } : {}),
    ...(state.operation ? { operation: { kind: state.operation.kind, status: state.operation.status, hash: state.operation.hash } } : {}),
  }
}
function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data))
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let content = ''
  for await (const chunk of request) {
    content += String(chunk)
    if (content.length > 50000) throw new Error('Operator request is too large.')
  }
  const parsed: unknown = JSON.parse(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.')
  return parsed as Record<string, unknown>
}
export async function createSessionApp(config: SessionServerConfig, dependencies: { adapter?: Session.Adapter; store?: Store.AtomicStore } = {}) {
  if (!dependencies.adapter) await inspectEscrow(config, nodeTransport(config, config.relayerPrivateKey))
  const release = dependencies.store ? () => {} : acquireLock(join(config.stateDir, 'server.lock'))
  try {
    const method = tron.session({ adapter: dependencies.adapter ?? serverAdapter(config), currency: config.tokenAddress,
      recipient: config.recipientAddress, credentialTypes: [config.credentialType], permit2Contract: config.permit2Address,
      chargeOnVerify: false, store: dependencies.store ?? fileStore(join(config.stateDir, 'server.json')) })
    const payment = Mppx.create({ secretKey: config.mppSecretKey, methods: [method] })
    const paid = Mppx.toNodeListener(payment.session({ amount: config.unitAmount, unitType: 'message', suggestedDeposit: config.deposit }))
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost')
        if (request.method === 'GET' && url.pathname === '/health') {
          json(response, 200, { status: 'ok', intent: 'session', credentialTypes: [config.credentialType], chainId: config.chainId,
            currency: config.tokenAddress, recipient: config.recipientAddress, escrowContract: config.escrowAddress,
            permit2Contract: config.permit2Address, unitAmount: config.unitAmount }); return
        }
        if (request.method === 'GET' && url.pathname === '/session/state') {
          const id = Bytes32Schema.parse(url.searchParams.get('channelId'))
          const [state, channel] = await Promise.all([method.manager.state(id), method.manager.parameters.adapter.channel(id)])
          json(response, 200, { channelId: id, state: publicState(state), channel }); return
        }
        if (request.method === 'POST' && ['/session/settle', '/session/reconcile'].includes(url.pathname)) {
          const expected = Buffer.from(`Bearer ${config.mppSecretKey}`), supplied = Buffer.from(request.headers.authorization ?? '')
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { json(response, 401, { error: 'Operator authorization required.' }); return }
          const input = await body(request), id = Bytes32Schema.parse(input.channelId)
          if (url.pathname === '/session/settle') {
            const settlement = await method.manager.settle(id)
            json(response, 200, { ...settlement, state: publicState(await method.manager.state(id)) }); return
          }
          if (input.funding) {
            const hash = await method.manager.reconcileFunding(Session.RequestSchema.parse(input.request), id, Session.FundingSchema.parse(input.funding))
            json(response, 200, { hash, state: publicState(await method.manager.state(id)) }); return
          }
          json(response, 200, { state: publicState(await method.manager.reconcile(id)) }); return
        }
        if (url.pathname !== '/session' || !['GET', 'POST', 'HEAD'].includes(request.method ?? '')) { json(response, 404, { error: 'Not found' }); return }
        const result = await paid(request, response)
        if (result.status !== 200) return // SDK has already returned a challenge or management receipt.
        const credential = Credential.deserialize(request.headers.authorization!)
        const payload = Session.PayloadSchema.parse(credential.payload)
        const terms = Session.RequestSchema.parse(credential.challenge.request)
        const initial = Receipt.deserialize(String(response.getHeader('payment-receipt')))
        const makeReceipt = (state: SessionState, units: number) => Receipt.from({ ...initial, acceptedCumulative: state.acceptedCumulative,
          spent: state.spent, units, timestamp: new Date().toISOString(), ...(state.txHash ? { txHash: state.txHash } : {}) })
        if (request.method === 'POST') { json(response, 200, { action: payload.action, receipt: initial, state: publicState(await method.manager.state(payload.channelId)) }); return }
        const stream = String(request.headers.accept ?? '').includes('text/event-stream')
        if (!stream) {
          const state = await method.manager.consume(terms, payload.channelId, 1, `app:${payload.requestAuthorization!.nonce}:0`)
          const receipt = makeReceipt(state, 1)
          response.setHeader('payment-receipt', Receipt.serialize(receipt))
          json(response, 200, { message: 'Session credit consumed. Premium content unlocked.', receipt, state: publicState(state) }); return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        let delivered = 0
        for (; delivered < config.streamUnits && !response.destroyed; delivered++) {
          try {
            await method.manager.consume(terms, payload.channelId, 1, `app:${payload.requestAuthorization!.nonce}:${delivered}`)
            response.write(`event: content\ndata: ${JSON.stringify({ index: delivered + 1, message: `Paid session message ${delivered + 1}` })}\n\n`)
          } catch (error) {
            const state = await method.manager.state(payload.channelId)
            if (state && (error as { code?: string }).code === 'insufficient-balance') response.write(needVoucherEvent({ channelId: payload.channelId,
              requiredCumulative: (BigInt(state.spent) + BigInt(terms.amount)).toString(), acceptedCumulative: state.acceptedCumulative, deposit: state.deposit }))
            else response.write(`event: payment-error\ndata: ${JSON.stringify({ error: 'Session unavailable; no further content delivered.' })}\n\n`)
            break
          }
        }
        const final = await method.manager.state(payload.channelId)
        if (final && !response.destroyed) response.write(receiptEvent(makeReceipt(final, delivered)))
        response.end()
      } catch (error) {
        const status = (error as { status?: number }).status
        console.error('Session request failed:', error instanceof Error ? error.message : 'Unknown error')
        if (!response.headersSent) {
          response.removeHeader('payment-receipt')
          json(response, status && status >= 400 && status <= 599 ? status : 500, { error: status ? (error as Error).message : 'Session request failed.' })
        }
        else response.end()
      }
    })
    server.once('close', release); server.once('error', release)
    return { server, manager: method.manager }
  } catch (error) { release(); throw error }
}
