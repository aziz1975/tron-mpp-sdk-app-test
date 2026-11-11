import { TronWeb } from 'tronweb'
import { encodeAbiParameters, encodeFunctionData, decodeFunctionResult, keccak256, parseAbi, toBytes, type Address } from 'viem'
import { normalizeAddress, toBase58Address } from 'tron-mpp-sdk'
import { createTronWebTransport, waitForReceipt } from 'tron-mpp-sdk/tronweb'
import { loadClientConfig } from './config.js'
import { createTronWeb } from './tron.js'

const abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function nonceBitmap(address,uint256) view returns (uint256)',
])

async function main() {
  const action = process.argv[2]
  if (!['inspect', 'approve', 'revoke'].includes(action ?? '')) throw new Error('Use inspect, approve, or revoke.')
  const config = loadClientConfig()
  if (!config.permit2) throw new Error('Set CHARGE_CREDENTIAL_TYPE=permit2 first.')
  const permit2 = config.permit2
  const payer = normalizeAddress(TronWeb.address.fromPrivateKey(config.payerPrivateKey) || '')
  // Inspect uses a node without a signing key; only explicit approve/revoke can broadcast.
  const tron = createTronWeb({ ...config, ...(action === 'inspect' ? {} : { privateKey: config.payerPrivateKey }) })
  const transport = createTronWebTransport(tron, { chainId: config.chainId })
  const balanceOf = async (owner: Address) => BigInt(await transport.call(config.tokenAddress, encodeFunctionData({ abi, functionName: 'balanceOf', args: [owner] }), payer))
  const allowance = async () => BigInt(await transport.call(config.tokenAddress, encodeFunctionData({ abi, functionName: 'allowance', args: [payer, permit2.address] }), payer))
  const domain = await transport.call(permit2.address, encodeFunctionData({ abi, functionName: 'DOMAIN_SEPARATOR' }), payer)
  const expectedDomain = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [keccak256(toBytes('EIP712Domain(string name,uint256 chainId,address verifyingContract)')), keccak256(toBytes('Permit2')), BigInt(config.chainId), permit2.address],
  ))
  if (domain.toLowerCase() !== expectedDomain.toLowerCase()) throw new Error('Deployed Permit2 domain does not match the SDK domain. Do not approve until the network/domain mismatch is resolved.')
  const currentAllowance = await allowance()
  if (action === 'inspect') {
    const [symbol, decimals, payerTokens, recipientTokens, payerTrx, relayerTrx, nonceWord] = await Promise.all([
      transport.call(config.tokenAddress, encodeFunctionData({ abi, functionName: 'symbol' }), payer),
      transport.call(config.tokenAddress, encodeFunctionData({ abi, functionName: 'decimals' }), payer),
      balanceOf(payer), balanceOf(config.recipientAddress),
      tron.trx.getBalance(toBase58Address(payer)), tron.trx.getBalance(toBase58Address(permit2.spender)),
      transport.call(permit2.address, encodeFunctionData({ abi, functionName: 'nonceBitmap', args: [payer, 0n] }), payer),
    ])
    console.log(JSON.stringify({
      network: 'nile', chainId: config.chainId, fullHost: config.fullHost,
      token: toBase58Address(config.tokenAddress), symbol: decodeFunctionResult({ abi, functionName: 'symbol', data: symbol }),
      decimals: decodeFunctionResult({ abi, functionName: 'decimals', data: decimals }),
      permit2: toBase58Address(permit2.address), spender: toBase58Address(permit2.spender),
      payer: toBase58Address(payer), recipient: toBase58Address(config.recipientAddress),
      payerTokenAtomic: payerTokens.toString(), recipientTokenAtomic: recipientTokens.toString(),
      payerTrxSun: payerTrx, relayerTrxSun: relayerTrx, allowanceAtomic: currentAllowance.toString(),
      approvalTargetAtomic: config.maxAtomicAmount, domainMatchesSdk: true, nonceBitmapWordZero: nonceWord.toString(),
      allowanceCoversClientCap: currentAllowance >= BigInt(config.maxAtomicAmount),
      balanceCoversClientCap: payerTokens >= BigInt(config.maxAtomicAmount),
    }, null, 2))
    return
  }
  const target = action === 'revoke' ? 0n : BigInt(config.maxAtomicAmount)
  if (currentAllowance === target) {
    console.log(`Allowance is already ${target} atomic units. No transaction submitted.`)
    return
  }
  if (action === 'approve' && currentAllowance !== 0n) throw new Error('Existing allowance is nonzero. Run npm run permit2:revoke before setting a new allowance.')
  console.log(`Setting USDT allowance: owner=${toBase58Address(payer)} spender=${toBase58Address(permit2.address)} amountAtomic=${target}`)
  const hash = await transport.send(config.tokenAddress, encodeFunctionData({ abi, functionName: 'approve', args: [permit2.address, target] }))
  console.log(`Approval transaction: ${hash}`)
  await waitForReceipt(transport, hash, { timeoutMs: config.transactionTimeoutMs, pollIntervalMs: config.pollIntervalMs, minConfirmations: config.minConfirmations })
  const actual = await allowance()
  if (actual !== target) throw new Error(`Approval confirmed but allowance is ${actual}, expected ${target}.`)
  console.log(`Confirmed allowance: ${actual} atomic units. Token balances were not transferred by this approval.`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Permit2 setup failed.')
  if (error && typeof error === 'object' && 'hash' in error && error.hash) console.error(`Check this transaction before retrying: ${error.hash}`)
  process.exitCode = 1
})
