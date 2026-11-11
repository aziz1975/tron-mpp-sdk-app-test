import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TronWeb } from 'tronweb'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem'
import { Session, computeChannelId, recoverSigner, payeeAuthorizationTypedData, voucherTypedData, zeroAddress } from 'tron-mpp-sdk'
import { createTronWebTransport, escrowAbi, type TronTransport, type TransactionReceipt } from 'tron-mpp-sdk/tronweb'
import { createSessionApp } from '../src/session-app.js'
import { serverAdapter, sessionViews } from '../src/session-chain.js'
import { fileStore } from '../src/session-storage.js'
import { SessionTestClient } from '../src/session-payment-client.js'
import type { SessionServerConfig, SessionClientConfig } from '../src/session-config.js'
import { key, payer, recipient, token, chainId } from './helpers.js'

export const escrow = `0x${'66'.repeat(20)}` as Address
export const permit2 = `0x${'55'.repeat(20)}` as Address
const relayerKey = '2'.repeat(64), payeeKey = '3'.repeat(64)
const topic = (signature: string) => keccak256(toBytes(signature)).slice(2)
const word = (value: string) => value.slice(2).toLowerCase().padStart(64, '0')
const uint = (value: bigint) => encodeAbiParameters([{ type: 'uint256' }], [value])

export async function sessionFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'session-app-test-'))
  const common = { chainId, port: 0, serverUrl: '', fullHost: 'http://127.0.0.1:1', tronProApiKey: undefined,
    tokenAddress: token, recipientAddress: recipient, escrowAddress: escrow, permit2Address: permit2, stateDir,
    unitAmount: '10', deposit: '100', topUp: '100', maxDeposit: '200', maxCumulative: '200', streamUnits: 4,
    transactionTimeoutMs: 15, pollIntervalMs: 1, minConfirmations: 1 }
  const serverConfig: SessionServerConfig = { ...common, relayerPrivateKey: relayerKey, payeePrivateKey: payeeKey, mppSecretKey: 'session-integration-secret-0123456789' }
  const channels = new Map<Hex, Session.Channel>(), receipts = new Map<Hex, TransactionReceipt>(), nonces = new Set<string>()
  const flags = { pending: false, now: BigInt(Math.floor(Date.now() / 1000)) }
  const counters = { funding: 0, settle: 0, close: 0, signatures: 0, payerSends: 0 }
  let balance = 1000n, allowance = 200n, merchant = 0n, held = 0n, sequence = 0
  const signing = (privateKey: string) => createTronWebTransport(new TronWeb({ fullHost: common.fullHost, privateKey }), { chainId }).signTypedData!
  const payeeSign = signing(payeeKey)
  const domain = (name: string, version?: string) => version ? keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [keccak256(toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), keccak256(toBytes(name)), keccak256(toBytes(version)), BigInt(chainId), escrow],
  )) : keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [keccak256(toBytes('EIP712Domain(string name,uint256 chainId,address verifyingContract)')), keccak256(toBytes(name)), BigInt(chainId), permit2]))
  const transportFor = (ownerKey: string): TronTransport => {
    const tw = new TronWeb({ fullHost: common.fullHost, privateKey: ownerKey })
    const owner = createTronWebTransport(tw, { chainId }).payer!
    const sign = signing(ownerKey)
    return { chainId, payer: owner, signTypedData: async data => { counters.signatures++; return sign(data) },
      async call(to, data) {
        const decoded = decodeFunctionData({ abi: [...escrowAbi, ...sessionViews], data })
        const args = decoded.args as readonly unknown[] | undefined
        switch (decoded.functionName) {
          case 'PERMIT2': return encodeAbiParameters([{ type: 'address' }], [permit2])
          case 'allowedTokens': return encodeAbiParameters([{ type: 'bool' }], [args![0] === token])
          case 'domainSeparator': return domain('EVM Payment Channel', '1')
          case 'DOMAIN_SEPARATOR': return domain('Permit2')
          case 'CLOSE_GRACE_PERIOD': return uint(900n)
          case 'balanceOf': return uint(args![0] === payer ? balance : args![0] === recipient ? merchant : held)
          case 'allowance': return uint(allowance)
          case 'nonceBitmap': return uint(0n)
          case 'channels': {
            const c = channels.get(args![0] as Hex)
            return encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint64' }, { type: 'bool' }],
              c ? [c.payer, c.payee, c.token, c.authorizedSigner, BigInt(c.deposit), BigInt(c.settled), BigInt(c.closeRequestedAt), c.finalized] : [zeroAddress, zeroAddress, zeroAddress, zeroAddress, 0n, 0n, 0n, false])
          }
          case 'withdraw': {
            const c = channels.get(args![0] as Hex)
            if (!c || c.finalized || !BigInt(c.closeRequestedAt) || flags.now < BigInt(c.closeRequestedAt) + 900n) throw new Error('Grace period has not elapsed.')
            return '0x'
          }
          default: return '0x'
        }
      },
      async send(to, data) {
        const { functionName, args: typed } = decodeFunctionData({ abi: [...escrowAbi, ...sessionViews], data })
        const args = typed as readonly unknown[]
        const hash = `0x${(++sequence).toString(16).padStart(64, '0')}` as Hex
        let logs: NonNullable<TransactionReceipt['log']> = []
        if (to === token && functionName === 'approve') { allowance = args[1] as bigint; counters.payerSends++ }
        else if (functionName === 'openWithPermit2' || functionName === 'topUpWithPermit2') {
          const open = functionName === 'openWithPermit2'
          const payee = open ? args[0] as Address : recipient, currency = open ? args[1] as Address : token
          const amount = args[open ? 2 : 1] as bigint, from = args[open ? 5 : 2] as Address
          const nonce = args[open ? 6 : 3] as bigint, deadline = args[open ? 7 : 4] as bigint, signature = args[open ? 8 : 5] as Hex
          const salt = open ? args[3] as Hex : undefined, signer = open ? args[4] as Address : zeroAddress
          const id = open ? computeChannelId({ payer: from, payee, token: currency, salt: salt!, authorizedSigner: signer, escrowContract: escrow, chainId }) : args[0] as Hex
          const intent: Session.Funding = { action: open ? 'open' : 'topUp', type: 'permit2', signature, ...(salt ? { salt, authorizedSigner: signer } : {}),
            authorization: { from, permitted: { token: currency, amount: amount.toString() }, nonce: nonce.toString(), deadline: deadline.toString(), witness: open ? { payee, salt: salt!, authorizedSigner: signer } : { channelId: id } } }
          const request: Session.Request = { amount: '10', currency: token, recipient, methodDetails: { chainId, escrowContract: escrow, permit2Contract: permit2 } }
          assert.equal(await recoverSigner(Session.fundingTypedData(request, id, intent), signature), payer)
          assert(!nonces.has(nonce.toString())); assert(deadline >= flags.now); assert(balance >= amount && allowance >= amount)
          nonces.add(nonce.toString()); balance -= amount; allowance -= amount; held += amount; counters.funding++
          if (open) { assert(!channels.has(id)); channels.set(id, { payer: from, payee, token: currency, authorizedSigner: signer, deposit: amount.toString(), settled: '0', closeRequestedAt: '0', finalized: false }) }
          else { const c = channels.get(id)!; c.deposit = (BigInt(c.deposit) + amount).toString() }
          logs = [{ address: escrow.slice(2), topics: open ? [topic('ChannelOpened(bytes32,address,address,address,uint128)'), id.slice(2), word(from), word(payee)] : [topic('ChannelToppedUp(bytes32,uint128)'), id.slice(2)],
            data: open ? encodeAbiParameters([{ type: 'address' }, { type: 'uint128' }], [token, amount]).slice(2) : uint(amount).slice(2) }]
        } else if (functionName === 'settleWithAuthorization' || functionName === 'closeWithAuthorization') {
          const [id, amount, nonce, deadline, authorization, voucher] = args as [Hex, bigint, bigint, bigint, Hex, Hex]
          const c = channels.get(id)!, action = functionName === 'settleWithAuthorization' ? 'settle' : 'close'
          assert.equal(await recoverSigner(payeeAuthorizationTypedData({ action, chainId, escrowContract: escrow, channelId: id, cumulativeAmount: amount.toString(), nonce: nonce.toString(), deadline: deadline.toString() }), authorization), recipient)
          if (amount > BigInt(c.settled)) assert.equal(await recoverSigner(voucherTypedData({ chainId, escrowContract: escrow, channelId: id, cumulativeAmount: amount.toString() }), voucher), payer)
          const delta = amount - BigInt(c.settled); assert(delta >= 0n && amount <= BigInt(c.deposit))
          merchant += delta; held -= delta; c.settled = amount.toString(); counters[action]++
          if (action === 'close') { const refund = BigInt(c.deposit) - amount; balance += refund; held -= refund; c.finalized = true }
        } else if (functionName === 'requestClose' || functionName === 'withdraw') {
          const c = channels.get(args[0] as Hex)!
          counters.payerSends++
          if (functionName === 'requestClose') { if (c.closeRequestedAt === '0') c.closeRequestedAt = flags.now.toString() }
          else { const refund = BigInt(c.deposit) - BigInt(c.settled); balance += refund; held -= refund; c.finalized = true }
        } else throw new Error(`Unexpected transaction: ${functionName}`)
        receipts.set(hash, { id: hash.slice(2), blockNumber: 1, receipt: { result: 'SUCCESS' }, log: logs })
        return hash
      },
      info: async hash => flags.pending ? {} : receipts.get(hash) ?? {}, blockNumber: async () => 1,
      inspectTransaction: async () => { throw new Error('No transaction credentials') }, signTransaction: async () => { throw new Error('No transaction credentials') }, broadcast: async () => { throw new Error('No raw broadcast') },
    }
  }
  const adapter = serverAdapter(serverConfig, transportFor(relayerKey), payeeSign)
  let app = await createSessionApp(serverConfig, { adapter, store: fileStore(join(stateDir, 'server.json')) })
  const listen = async (port: number) => {
    // Each real CLI invocation has a fresh connection pool; avoid reusing sockets across a test server restart.
    app.server.prependListener('request', (_request, response) => response.setHeader('connection', 'close'))
    app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening')
  }
  await listen(0)
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  const clientConfig: SessionClientConfig = { ...common, serverUrl: `http://127.0.0.1:${address.port}`, payerPrivateKey: key, payer }
  const clientTransport = transportFor(key)
  const close = async () => { await new Promise<void>((resolve, reject) => { app.server.close(error => error ? reject(error) : resolve()); app.server.closeAllConnections() }) }
  return { config: clientConfig, serverConfig, flags, counters, channels, transport: clientTransport,
    client: new SessionTestClient(clientConfig, clientTransport), get manager() { return app.manager }, close,
    restart: async () => { await close(); app = await createSessionApp(serverConfig, { adapter, store: fileStore(join(stateDir, 'server.json')) }); await listen(address.port) },
    balances: () => ({ payer: balance, merchant, escrow: held, allowance }),
  }
}
