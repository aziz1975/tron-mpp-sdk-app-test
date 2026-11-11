import { join } from 'node:path'
import { Challenge, Credential, Receipt, z } from 'mppx'
import { Bytes32Schema, Session, Uint128Schema, computeChannelId, normalizeAddress, zeroAddress, TransactionNotSubmittedError, TransactionRevertedError } from 'tron-mpp-sdk'
import { tron, authorizeSessionRequest } from 'tron-mpp-sdk/client'
import { createSessionWallet, escrowAbi, waitForReceipt, type TronTransport } from 'tron-mpp-sdk/tronweb'
import { encodeFunctionData, type Hex } from 'viem'
import { confirmations, inspectEscrow, nodeTransport, randomHex, sessionViews } from './session-chain.js'
import { readJson, writeJson } from './session-storage.js'
import type { SessionClientConfig } from './session-config.js'

const Pending = z.object({ authorization: z.string(), method: z.enum(['POST', 'GET', 'HEAD']), stream: z.boolean() })
const Saved = z.object({ version: z.literal(1), binding: z.string(), channelId: z.optional(Bytes32Schema),
  pending: z.optional(Pending), last: z.optional(Pending), receipt: z.optional(z.string()),
  chainOperation: z.optional(z.object({ action: z.enum(['approve', 'requestClose', 'withdraw']), hash: z.optional(Bytes32Schema) })),
})
type SavedState = z.infer<typeof Saved>
export type SessionAction = 'open' | 'voucher' | 'topUp' | 'merge' | 'pay' | 'stream' | 'close'

export class SessionTestClient {
  readonly transport: TronTransport
  readonly wallet: ReturnType<typeof createSessionWallet>
  private saved: SavedState
  private readonly path: string
  constructor(readonly config: SessionClientConfig, transport = nodeTransport(config, config.payerPrivateKey)) {
    this.transport = transport; this.wallet = createSessionWallet(transport, config.escrowAddress, confirmations(config))
    this.path = join(config.stateDir, 'client.json')
    const binding = JSON.stringify([config.chainId, config.serverUrl, config.tokenAddress, config.recipientAddress, config.escrowAddress, config.permit2Address, config.payer])
    const existing = readJson(this.path)
    this.saved = existing === null ? { version: 1, binding } : Saved.parse(existing)
    if (this.saved.binding !== binding) throw new Error('Saved session belongs to different wallets, contracts, or server. Use a separate SESSION_STATE_DIR.')
  }
  private save() { writeJson(this.path, this.saved) }
  get channelId() { return this.saved.channelId }
  get pending() { return Boolean(this.saved.pending || this.saved.chainOperation) }
  private id(): Hex { if (!this.saved.channelId) throw new Error('Open a session first.'); return this.saved.channelId }
  private async remoteState() {
    const response = await fetch(`${this.config.serverUrl}/session/state?channelId=${this.id()}`)
    if (!response.ok) throw new Error(`Cannot read session accounting: HTTP ${response.status}`)
    const data = await response.json() as { state: { acceptedCumulative: string; spent: string; closed: boolean; closing: boolean } | null }
    if (!data.state) throw new Error('Server accounting is not initialized. Retry or reconcile the saved open.')
    Uint128Schema.parse(data.state.acceptedCumulative); Uint128Schema.parse(data.state.spent)
    return data.state
  }
  private validate(challenge: Challenge.Challenge) {
    const request = Session.RequestSchema.parse(challenge.request), c = this.config
    if (challenge.method !== 'tron' || challenge.intent !== 'session' || request.methodDetails.chainId !== c.chainId ||
      normalizeAddress(request.currency) !== c.tokenAddress || normalizeAddress(request.recipient) !== c.recipientAddress ||
      normalizeAddress(request.methodDetails.escrowContract) !== c.escrowAddress ||
      normalizeAddress(request.methodDetails.permit2Contract ?? '') !== c.permit2Address || request.methodDetails.feePayer !== true ||
      JSON.stringify(request.methodDetails.credentialTypes) !== '["permit2"]' || request.amount !== c.unitAmount) throw new Error('Session challenge does not match local policy. Restart the matching server/configuration.')
    if (!challenge.expires || !Number.isFinite(Date.parse(challenge.expires)) || Date.parse(challenge.expires) <= Date.now()) throw new Error('Session challenge expired.')
    return request
  }
  async challenge(method = 'POST') {
    const response = await fetch(`${this.config.serverUrl}/session`, { method })
    if (response.status !== 402) throw new Error(`Expected session challenge, received HTTP ${response.status}.`)
    const challenge = Challenge.fromResponse(response)
    this.validate(challenge)
    return challenge
  }
  private async funding(amount: string, channelId?: Hex, salt?: Hex): Promise<Session.FundingIntent> {
    const c = this.config
    const [balance, allowance] = await Promise.all([
      this.transport.call(c.tokenAddress, encodeFunctionData({ abi: sessionViews, functionName: 'balanceOf', args: [c.payer] })),
      this.transport.call(c.tokenAddress, encodeFunctionData({ abi: sessionViews, functionName: 'allowance', args: [c.payer, c.permit2Address] })),
    ])
    if (BigInt(balance) < BigInt(amount)) throw new Error('Payer token balance does not cover this deposit.')
    if (BigInt(allowance) < BigInt(amount)) throw new Error('Permit2 allowance does not cover this deposit. Run session:approve.')
    const nonce = BigInt(randomHex())
    const used = BigInt(await this.transport.call(c.permit2Address, encodeFunctionData({ abi: sessionViews, functionName: 'nonceBitmap', args: [c.payer, nonce >> 8n] })))
    if (used & (1n << (nonce & 255n))) throw new Error('Random Permit2 nonce is already consumed; prepare again.')
    return { action: channelId ? 'topUp' : 'open', type: 'permit2', ...(salt ? { salt } : {}),
      authorization: { from: c.payer, permitted: { token: c.tokenAddress, amount }, nonce: nonce.toString(),
        deadline: String(Math.floor(Date.now() / 1000) + 300), witness: channelId ? { channelId } : { payee: c.recipientAddress, salt: salt!, authorizedSigner: zeroAddress } } }
  }
  async execute(action: SessionAction, amountInput?: string) {
    if (this.pending) throw new Error('An operation is unresolved. Use session:retry or session:reconcile before creating another payment.')
    const c = this.config
    const httpMethod = action === 'voucher' || action === 'merge' ? 'HEAD' : action === 'pay' || action === 'stream' ? 'GET' : 'POST'
    const challenge = await this.challenge(httpMethod)
    await inspectEscrow(c, this.transport)
    const method = tron.session({ chainIds: [c.chainId], currencies: [c.tokenAddress], escrowContracts: [c.escrowAddress], payer: c.payer,
      maxUnitAmount: c.unitAmount, maxCumulativeAmount: c.maxCumulative, wallet: this.wallet,
      preparePayment: async () => {
        if (action === 'open') {
          if (this.saved.channelId) {
            const previous = await this.wallet.adapter.channel(this.saved.channelId)
            if (previous && !previous.finalized) throw new Error('An active session is already saved. Close it before opening another.')
            if (!previous && this.saved.receipt) throw new Error('A previously confirmed channel cannot be found. Investigate before another deposit.')
          }
          const salt = randomHex(), funding = await this.funding(c.deposit, undefined, salt)
          const id = computeChannelId({ payer: c.payer, payee: c.recipientAddress, token: c.tokenAddress, salt, escrowContract: c.escrowAddress, chainId: c.chainId })
          return Session.PaymentPlanSchema.parse({ ...funding, channelId: id, cumulativeAmount: '0' })
        }
        const id = this.id(), channel = await this.wallet.adapter.channel(id)
        if (!channel || channel.finalized) throw new Error('The saved channel is absent or finalized.')
        const state = await this.remoteState()
        if (state.closed || state.closing) throw new Error('Server session is closing or closed; inspect/reconcile it.')
        const additional = action === 'topUp' || action === 'merge' ? Uint128Schema.parse(action === 'topUp' && amountInput ? amountInput : c.topUp) : '0'
        const deposit = BigInt(channel.deposit) + BigInt(additional)
        if (deposit > BigInt(c.maxDeposit)) throw new Error('Total channel deposit would exceed SESSION_MAX_DEPOSIT_ATOMIC.')
        if (action === 'topUp') {
          const funding = await this.funding(additional, id)
          return Session.PaymentPlanSchema.parse({ ...funding, channelId: id, additionalDeposit: additional })
        }
        let cumulative = BigInt(state.acceptedCumulative)
        if (action === 'close') cumulative = BigInt(state.spent) > BigInt(channel.settled) ? BigInt(state.spent) : BigInt(channel.settled)
        else if (action === 'voucher' || action === 'merge') {
          cumulative = amountInput ? BigInt(Uint128Schema.parse(amountInput)) : cumulative + BigInt(c.unitAmount) * BigInt(c.streamUnits)
          if (cumulative <= BigInt(state.acceptedCumulative)) throw new Error('New cumulative voucher must exceed acceptedCumulative.')
        }
        if (cumulative > deposit || cumulative > BigInt(c.maxCumulative)) throw new Error('Voucher exceeds the deposit or cumulative spending cap. Top up or choose a smaller cumulative amount.')
        return Session.PaymentPlanSchema.parse({ action: action === 'close' ? 'close' : 'voucher', channelId: id, cumulativeAmount: cumulative.toString(),
          ...(action === 'merge' ? { deposit: await this.funding(additional, id) } : {}) })
      } })
    const authorization = await method.createCredential({ challenge: { ...challenge, request: Session.RequestSchema.parse(challenge.request), method: 'tron', intent: 'session' } })
    const payload = Session.PayloadSchema.parse(Credential.deserialize(authorization).payload)
    if (payload.action === 'open' && payload.channelId !== this.saved.channelId) { delete this.saved.receipt; delete this.saved.last }
    this.saved.channelId = payload.channelId
    this.saved.pending = { authorization, method: httpMethod, stream: action === 'stream' }
    this.save() // Persist the exact credential before the server can submit a deposit.
    return this.submitPending()
  }
  private async submitPending() {
    const pending = this.saved.pending
    if (!pending) throw new Error('There is no saved HTTP request to retry.')
    const response = await fetch(`${this.config.serverUrl}/session`, { method: pending.method,
      headers: { authorization: pending.authorization, ...(pending.stream ? { accept: 'text/event-stream' } : {}) } })
    const text = await response.text()
    if (response.ok) {
      let receipt: Receipt.Receipt & Record<string, unknown> = Receipt.fromResponse(response)
      if (pending.stream) {
        const last = text.split(/\r?\n\r?\n/).reverse().find(event => event.startsWith('event: payment-receipt\n'))
        if (last) receipt = Receipt.from(JSON.parse(last.slice(last.indexOf('data: ') + 6)))
      }
      if (receipt.method !== 'tron' || receipt.intent !== 'session' || receipt.reference !== this.id() ||
        receipt.channelId !== this.id() || receipt.chainId !== this.config.chainId) throw new Error('Receipt does not match the saved channel.')
      const accepted = Uint128Schema.parse(receipt.acceptedCumulative), spent = Uint128Schema.parse(receipt.spent)
      if (BigInt(spent) > BigInt(accepted) || BigInt(accepted) > BigInt(this.config.maxCumulative)) throw new Error('Receipt accounting exceeds client policy.')
      this.saved.receipt = Receipt.serialize(receipt)
      this.saved.last = pending; delete this.saved.pending; this.save()
      return { status: response.status, receipt, body: text }
    }
    // These responses cannot grant another handler execution. Keep uncertain submissions intact.
    if (response.status === 409 || response.status === 410 || (response.status === 402 && pending.method === 'GET')) { delete this.saved.pending; this.save() }
    return { status: response.status, body: text, pending: this.pending }
  }
  async retry() {
    if (this.saved.chainOperation) {
      const operation = this.saved.chainOperation
      if (!operation.hash) throw new Error('Submission has no known hash. Investigate the payer transaction before retrying.')
      try { await waitForReceipt(this.transport, operation.hash, confirmations(this.config)) }
      catch (error) {
        if ((error as { code?: string }).code === 'transaction-reverted') { delete this.saved.chainOperation; this.save() }
        throw error
      }
      delete this.saved.chainOperation; this.save()
      return { status: 200, hash: operation.hash }
    }
    if (!this.saved.pending) throw new Error('There is no saved request to retry.')
    const original = Credential.deserialize(this.saved.pending.authorization)
    if (Date.parse(original.challenge.expires ?? '') <= Date.now()) {
      if (this.saved.pending.method === 'GET') throw new Error('This paid request expired. Inspect/reconcile its result before another paid request.')
      const challenge = await this.challenge(this.saved.pending.method)
      const payload = await authorizeSessionRequest({ ...challenge, request: Session.RequestSchema.parse(challenge.request) }, Session.PayloadSchema.parse(original.payload), data => this.wallet.signRequest(data, Session.PayloadSchema.parse(original.payload).action))
      this.saved.pending.authorization = Credential.serialize(Credential.from({ challenge, payload, ...(original.source ? { source: original.source } : {}) }))
      this.save()
    }
    return this.submitPending()
  }
  async replay() {
    if (!this.saved.last) throw new Error('There is no successful credential to replay.')
    const saved = this.saved.last
    const response = await fetch(`${this.config.serverUrl}/session`, { method: saved.method, headers: { authorization: saved.authorization } })
    return { status: response.status, body: await response.text(), management: saved.method === 'HEAD' }
  }
  async operator(action: 'settle' | 'reconcile', secret: string) {
    if (!secret) throw new Error('MPP_SECRET_KEY is required for operator actions.')
    const input: Record<string, unknown> = { channelId: this.id() }
    if (action === 'reconcile' && this.saved.pending) {
      const credential = Credential.deserialize(this.saved.pending.authorization), payload = Session.PayloadSchema.parse(credential.payload)
      const funding = payload.action === 'voucher' ? payload.deposit : 'type' in payload && payload.type === 'permit2' ? Session.FundingSchema.parse(payload) : undefined
      if (funding) { input.funding = funding; input.request = credential.challenge.request }
    }
    const response = await fetch(`${this.config.serverUrl}/session/${action}`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(input) })
    const text = await response.text()
    if (action === 'reconcile' && response.ok && this.saved.pending) {
      const result = JSON.parse(text) as { state?: { closed?: boolean; operation?: unknown } | null }
      // Explicit reconciliation acknowledges an uncertain service result; it never redelivers or funds.
      if (result.state?.closed || (this.saved.pending.method === 'GET' && result.state && !result.state.operation)) {
        delete this.saved.pending; this.save()
      }
    }
    return { status: response.status, body: text }
  }
  async inspect() {
    const checked = await inspectEscrow(this.config, this.transport)
    const [balance, allowance, channel] = await Promise.all([
      this.transport.call(this.config.tokenAddress, encodeFunctionData({ abi: sessionViews, functionName: 'balanceOf', args: [this.config.payer] })),
      this.transport.call(this.config.tokenAddress, encodeFunctionData({ abi: sessionViews, functionName: 'allowance', args: [this.config.payer, this.config.permit2Address] })),
      this.saved.channelId ? this.wallet.adapter.channel(this.saved.channelId) : null,
    ])
    return { payer: this.config.payer, escrow: this.config.escrowAddress, permit2: this.config.permit2Address, gracePeriod: checked.gracePeriod,
      balance: BigInt(balance).toString(), allowance: BigInt(allowance).toString(), channelId: this.saved.channelId, channel,
      pending: this.saved.pending ? { method: this.saved.pending.method, action: Session.PayloadSchema.parse(Credential.deserialize(this.saved.pending.authorization).payload).action } : this.saved.chainOperation,
      receipt: this.saved.receipt ? Receipt.deserialize(this.saved.receipt) : undefined }
  }
  async approve(revoke = false) {
    if (this.pending) throw new Error('Resolve the saved operation before changing its allowance.')
    await inspectEscrow(this.config, this.transport)
    const current = BigInt(await this.transport.call(this.config.tokenAddress, encodeFunctionData({ abi: sessionViews, functionName: 'allowance', args: [this.config.payer, this.config.permit2Address] })))
    const target = revoke ? 0n : BigInt(this.config.maxDeposit)
    if (current === target) return { unchanged: true, allowance: current.toString() }
    if (current !== 0n && target !== 0n) throw new Error('Existing allowance differs. Run session:revoke before session:approve.')
    // Persist an ambiguous approval too; retry confirms this hash without sending again.
    return this.chainTransaction('approve', encodeFunctionData({ abi: sessionViews, functionName: 'approve', args: [this.config.permit2Address, target] }), this.config.tokenAddress)
  }
  private async chainTransaction(action: 'approve' | 'requestClose' | 'withdraw', data: Hex, to = this.config.escrowAddress) {
    if (this.saved.chainOperation) throw new Error('A payer transaction is unresolved; use session:retry.')
    await this.transport.call(to, data)
    this.saved.chainOperation = { action }
    this.save()
    try {
      const hash = await this.transport.send(to, data)
      this.saved.chainOperation.hash = hash; this.save()
      await waitForReceipt(this.transport, hash, confirmations(this.config))
      delete this.saved.chainOperation; this.save()
      return { status: 200, action, hash }
    } catch (error) {
      const failure = error as { hash?: Hex; code?: string }
      if (failure.hash && this.saved.chainOperation) { this.saved.chainOperation.hash = failure.hash; this.save() }
      if (error instanceof TransactionNotSubmittedError || error instanceof TransactionRevertedError || failure.code === 'transaction-reverted') { delete this.saved.chainOperation; this.save() }
      throw error
    }
  }
  async force(action: 'requestClose' | 'withdraw') {
    return this.chainTransaction(action, encodeFunctionData({ abi: escrowAbi, functionName: action, args: [this.id()] }))
  }
}
