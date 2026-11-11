import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { Challenge, Credential, Receipt } from 'mppx'
import { TronWeb } from 'tronweb'
import { decodeFunctionData, keccak256, parseAbi, toBytes, type Hex } from 'viem'
import { Charge, normalizeAddress, toBase58Address } from 'tron-mpp-sdk'
import { createTronWebTransport, type TronTransport } from 'tron-mpp-sdk/tronweb'
import { createAppServer } from '../src/app.js'
import { createPaymentClientMethod } from '../src/payment-client.js'
import { loadClientConfig, loadServerConfig } from '../src/config.js'
import { chainId, clientConfig, serverConfig, key, payer, recipient, token, wallet } from './helpers.js'

const permit2 = normalizeAddress(TronWeb.address.fromPrivateKey('5'.repeat(64)) as string)
const relayerKey = '2'.repeat(64)
const spender = normalizeAddress(TronWeb.address.fromPrivateKey(relayerKey) as string)
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'])
const permitAbi = parseAbi(['function permitWitnessTransferFrom(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount) transferDetails,address owner,bytes32 witness,string witnessTypeString,bytes signature)'])
const transferTopic = keccak256(toBytes('Transfer(address,address,uint256)')).slice(2)

test('Permit2-only charge signs off-chain, relays once, verifies transfer, and rejects replay', async t => {
  let allowance = 1000000n, sends = 0, signatures = 0
  let receipt = {}
  const hash = `0x${'ab'.repeat(32)}` as Hex
  const word = (value: string) => value.slice(2).toLowerCase().padStart(64, '0')
  const transport: TronTransport = {
    chainId, payer: toBase58Address(spender),
    call: async (to, data) => {
      if (to === permit2) return `0x${'0'.repeat(64)}`
      const { functionName } = decodeFunctionData({ abi: tokenAbi, data })
      return `0x${(functionName === 'balanceOf' ? 1000000n : allowance).toString(16).padStart(64, '0')}`
    },
    send: async (to, data) => {
      assert.equal(to, permit2)
      const { args } = decodeFunctionData({ abi: permitAbi, data })
      const [permission, detail, owner] = args
      assert.equal(normalizeAddress(owner), payer)
      assert.equal(normalizeAddress(permission.permitted.token), token)
      assert.equal(normalizeAddress(detail.to), recipient)
      assert.equal(detail.requestedAmount, 1000000n)
      assert(allowance >= detail.requestedAmount)
      allowance -= detail.requestedAmount; sends++
      receipt = { id: hash.slice(2), blockNumber: 100, receipt: { result: 'SUCCESS' }, log: [{
        address: token.slice(2), topics: [transferTopic, word(owner), word(detail.to)], data: detail.requestedAmount.toString(16).padStart(64, '0'),
      }] }
      return hash
    },
    inspectTransaction: async () => { throw new Error('Unexpected transaction credential') },
    signTransaction: async () => { throw new Error('Unexpected transaction signing') },
    broadcast: async () => { throw new Error('Unexpected transaction broadcast') },
    info: async () => receipt,
    blockNumber: async () => 100,
  }
  const config = { ...serverConfig(), credentialType: 'permit2' as const, permit2: { address: permit2, spender }, relayerPrivateKey: relayerKey }
  const server = createAppServer(config, transport)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections()
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP server')
  const url = `http://127.0.0.1:${address.port}/premium`
  const sign = createTronWebTransport(wallet, { chainId }).signTypedData!
  const clientTransport = { ...transport, payer: toBase58Address(payer), signTypedData: async (data: Parameters<typeof sign>[0]) => { signatures++; return sign(data) } }
  const client = { ...clientConfig(), credentialType: 'permit2' as const, permit2: config.permit2 }
  const { method } = createPaymentClientMethod(client, clientTransport)
  const challenge = Challenge.fromResponse(await fetch(url), { methods: [method] })
  assert.equal(challenge.intent, 'charge')
  assert.deepEqual(challenge.request.methodDetails.credentialTypes, ['permit2'])
  assert.equal(normalizeAddress(challenge.request.methodDetails.spender!), spender)
  const changed = createPaymentClientMethod({ ...client, permit2: { address: permit2, spender: token } }, clientTransport)
  await assert.rejects(changed.method.createCredential({ challenge }), /supported credential/)
  assert.equal(signatures, 0)
  allowance = 0n
  await assert.rejects(method.createCredential({ challenge }), /approval/)
  assert.equal(signatures, 0)
  allowance = 1000000n
  const header = await method.createCredential({ challenge })
  assert.equal(Charge.PayloadSchema.parse(Credential.deserialize(header).payload).type, 'permit2')
  assert.equal(signatures, 1); assert.equal(sends, 0)
  const paid = await fetch(url, { headers: { authorization: header } })
  assert.equal(paid.status, 200)
  assert.equal(Receipt.fromResponse(paid).reference, hash)
  assert.equal(sends, 1); assert.equal(allowance, 0n)
  assert.equal((await fetch(url, { headers: { authorization: header } })).status, 402)
  assert.equal(sends, 1)
})

test('Permit2 configuration requires a trusted contract/spender and a matching server relayer key', () => {
  const original = process.env
  try {
    process.env = { MPP_SECRET_KEY: 'local-config-secret', TRON_PAYER_PRIVATE_KEY: key, TRON_TOKEN_ADDRESS: token, TRON_RECIPIENT_ADDRESS: recipient,
      CHARGE_CREDENTIAL_TYPE: 'permit2', TRON_PERMIT2_ADDRESS: toBase58Address(permit2), TRON_PERMIT2_SPENDER_ADDRESS: toBase58Address(spender) }
    const config = loadClientConfig()
    assert.equal(config.credentialType, 'permit2'); assert.deepEqual(config.permit2, { address: permit2, spender })
    assert.throws(loadServerConfig, /TRON_RELAYER_PRIVATE_KEY/)
    process.env.TRON_RELAYER_PRIVATE_KEY = key
    assert.throws(loadServerConfig, /must belong to/)
    process.env.TRON_RELAYER_PRIVATE_KEY = relayerKey
    assert.equal(loadServerConfig().relayerPrivateKey, relayerKey)
    delete process.env.TRON_PAYER_PRIVATE_KEY
    assert.equal(loadServerConfig().credentialType, 'permit2')
    for (const name of ['TRON_PERMIT2_ADDRESS', 'TRON_PERMIT2_SPENDER_ADDRESS']) {
      const value = process.env[name]
      process.env[name] = ''
      assert.throws(loadServerConfig, new RegExp(name))
      process.env[name] = value
    }
    process.env.CHARGE_CREDENTIAL_TYPE = 'session'
    assert.throws(loadServerConfig, /CHARGE_CREDENTIAL_TYPE/)
    process.env.CHARGE_CREDENTIAL_TYPE = 'transaction'
    delete process.env.TRON_RELAYER_PRIVATE_KEY
    assert.equal(loadServerConfig().relayerPrivateKey, undefined)
  } finally { process.env = original }
})
