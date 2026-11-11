import { once } from 'node:events'
import { Challenge } from 'mppx'
import { TronWeb, utils, type Types } from 'tronweb'
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from 'viem'
import { chains, normalizeAddress, toBase58Address } from 'tron-mpp-sdk'
import { createTronWebTransport, type TronTransport } from 'tron-mpp-sdk/tronweb'
import { createAppServer } from '../src/app.js'
import { createPaymentClientMethod } from '../src/payment-client.js'
import type { ServerConfig, ClientConfig } from '../src/config.js'

// Public deterministic test keys; no .env or blockchain RPC is used.
export const key = '1'.repeat(64)
export const wallet = new TronWeb({ fullHost: 'http://127.0.0.1:1', privateKey: key })
export const payer = normalizeAddress(wallet.defaultAddress.base58 as string)
export const recipient = normalizeAddress(TronWeb.address.fromPrivateKey('3'.repeat(64)) as string)
export const token = normalizeAddress(TronWeb.address.fromPrivateKey('4'.repeat(64)) as string)
export const chainId = chains.nile
export const abi = parseAbi(['function transfer(address,uint256)'])
const transferTopic = keccak256(toBytes('Transfer(address,address,uint256)')).slice(2)
const word = (address: Address) => address.slice(2).toLowerCase().padStart(64, '0')

export function serverConfig(amount = '1000000'): ServerConfig {
  return { chainId, fullHost: 'http://127.0.0.1:1', tronProApiKey: undefined, tokenAddress: token, recipientAddress: recipient,
    credentialType: 'transaction', permit2: undefined, relayerPrivateKey: undefined,
    transactionTimeoutMs: 25, pollIntervalMs: 1, minConfirmations: 1, port: 0,
    mppSecretKey: 'local-test-secret-0123456789abcdef', paymentAmountAtomic: amount }
}
export function clientConfig(): ClientConfig {
  const { mppSecretKey: _secret, paymentAmountAtomic: _amount, relayerPrivateKey: _relayer, ...shared } = serverConfig()
  return { ...shared, payerPrivateKey: key, serverUrl: 'http://127.0.0.1:1', maxAtomicAmount: '1000000' }
}

export async function signedTransaction(to: Address, data: Hex, sequence = 1, callValue = 0): Promise<string> {
  const unsigned = { visible: false, raw_data: {
    ref_block_bytes: '1234', ref_block_hash: sequence.toString(16).padStart(16, '0'),
    expiration: Date.now() + 60000, timestamp: Date.now(), fee_limit: 100000000,
    contract: [{ type: 'TriggerSmartContract', parameter: { type_url: 'type.googleapis.com/protocol.TriggerSmartContract', value: {
      owner_address: `41${payer.slice(2)}`, contract_address: `41${to.slice(2)}`, data: data.slice(2), call_value: callValue,
    } } }],
  } }
  const protobuf = utils.transaction.txJsonToPb(unsigned)
  const tx = { ...unsigned, raw_data_hex: utils.transaction.txPbToRawDataHex(protobuf), txID: utils.transaction.txPbToTxID(protobuf).replace(/^0x/, '') }
  return JSON.stringify(await wallet.trx.sign(tx as unknown as Types.Transaction))
}

export function simulatedTransport() {
  const flags = { pending: false, failed: false, wrongAmount: false, wrongRecipient: false, wrongPayer: false, wrongToken: false,
    missingLog: false, rpcFailure: false, currentBlock: 100 }
  const counters = { signatures: 0, broadcasts: 0, queries: 0, simulations: 0 }
  const txs = new Map<Hex, { from: Address; to: Address; data: Hex }>()
  const inspect = createTronWebTransport(wallet, { chainId }).inspectTransaction
  const transport: TronTransport = {
    chainId, payer: toBase58Address(payer), inspectTransaction: inspect,
    call: async () => { counters.simulations++; return `0x${'0'.repeat(63)}1` },
    send: async () => { throw new Error('Unexpected relayed or native payment') },
    signTransaction: async (to, data) => signedTransaction(to, data, ++counters.signatures),
    broadcast: async envelope => {
      const tx = await inspect(envelope)
      counters.broadcasts++; txs.set(tx.hash, tx)
      return tx.hash
    },
    info: async hash => {
      counters.queries++
      if (flags.rpcFailure) throw new Error('simulated RPC outage')
      const tx = txs.get(hash)
      if (!tx || flags.pending) return {}
      const { args } = decodeFunctionData({ abi, data: tx.data })
      return { id: hash.slice(2), blockNumber: 100, blockTimeStamp: Date.now(), receipt: { result: flags.failed ? 'REVERT' : 'SUCCESS' },
        log: flags.missingLog ? [] : [{ address: (flags.wrongToken ? recipient : tx.to).slice(2),
          topics: [transferTopic, word(flags.wrongPayer ? recipient : tx.from), word(flags.wrongRecipient ? payer : args[0])],
          data: (flags.wrongAmount ? 1n : args[1]).toString(16).padStart(64, '0'),
        }],
      }
    },
    blockNumber: async () => flags.currentBlock,
  }
  return { flags, counters, transport }
}

export async function fixture(options: { amount?: string; clientChainId?: number; maxAtomicAmount?: string } = {}) {
  const sim = simulatedTransport()
  const server = createAppServer(serverConfig(options.amount), sim.transport)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP server')
  const url = `http://127.0.0.1:${address.port}`
  const config = { ...clientConfig(), serverUrl: url, ...(options.maxAtomicAmount ? { maxAtomicAmount: options.maxAtomicAmount } : {}) }
  const { method } = createPaymentClientMethod(config, { ...sim.transport, chainId: options.clientChainId ?? chainId })
  const challenge = async () => Challenge.fromResponse(await fetch(`${url}/premium`), { methods: [method] })
  const submit = (authorization: string) => fetch(`${url}/premium`, { headers: { authorization } })
  return { ...sim, server, url, method, challenge, submit,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections()
    }),
  }
}

export const transferData = (to = recipient, amount = 1000000n) => encodeFunctionData({ abi, functionName: 'transfer', args: [to, amount] })
