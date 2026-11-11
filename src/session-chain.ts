import { encodeFunctionData, parseAbi, decodeAbiParameters, keccak256, encodeAbiParameters, toBytes, type Hex } from 'viem'
import { Session, normalizeAddress, payeeAuthorizationTypedData, type TypedSigner } from 'tron-mpp-sdk'
import { createSessionAdapter, createSessionRelayer, createTronWebTransport, type TronTransport } from 'tron-mpp-sdk/tronweb'
import { randomBytes } from 'node:crypto'
import { createTronWeb } from './tron.js'
import type { SessionConfig, SessionServerConfig } from './session-config.js'

export const randomHex = (): Hex => `0x${randomBytes(32).toString('hex')}`
export const confirmations = (config: SessionConfig) => ({ timeoutMs: config.transactionTimeoutMs, pollIntervalMs: config.pollIntervalMs, minConfirmations: config.minConfirmations })
export const sessionViews = parseAbi([
  'function PERMIT2() view returns (address)', 'function allowedTokens(address) view returns (bool)',
  'function domainSeparator() view returns (bytes32)', 'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function nonceBitmap(address,uint256) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
])
export function nodeTransport(config: SessionConfig, privateKey?: string) {
  return createTronWebTransport(createTronWeb({ ...config, ...(privateKey ? { privateKey } : {}) }), { chainId: config.chainId })
}
export async function inspectEscrow(config: SessionConfig, transport: TronTransport) {
  const adapter = createSessionAdapter(transport, config.escrowAddress, confirmations(config))
  const read = (to: string, functionName: 'PERMIT2' | 'allowedTokens' | 'domainSeparator' | 'DOMAIN_SEPARATOR', args?: readonly [typeof config.tokenAddress]) => transport.call(normalizeAddress(to), encodeFunctionData({ abi: sessionViews, functionName, ...(args ? { args } : {}) } as Parameters<typeof encodeFunctionData>[0]))
  const [permit, allowed, grace, domain, permitDomain] = await Promise.all([
    read(config.escrowAddress, 'PERMIT2'), read(config.escrowAddress, 'allowedTokens', [config.tokenAddress]), adapter.gracePeriod(),
    read(config.escrowAddress, 'domainSeparator'), read(config.permit2Address, 'DOMAIN_SEPARATOR'),
  ])
  const [configured] = decodeAbiParameters([{ type: 'address' }], permit)
  if (normalizeAddress(configured) !== config.permit2Address) throw new Error('Escrow PERMIT2() does not match TRON_PERMIT2_ADDRESS.')
  if (!decodeAbiParameters([{ type: 'bool' }], allowed)[0]) throw new Error('The escrow does not allow TRON_TOKEN_ADDRESS.')
  if (!Number.isSafeInteger(grace) || grace < 900) throw new Error('Escrow close grace period must be at least 900 seconds.')
  const domainHash = (name: string, version?: string) => keccak256(encodeAbiParameters(
    version ? [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }] : [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    version ? [keccak256(toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), keccak256(toBytes(name)), keccak256(toBytes(version)), BigInt(config.chainId), config.escrowAddress] : [keccak256(toBytes('EIP712Domain(string name,uint256 chainId,address verifyingContract)')), keccak256(toBytes(name)), BigInt(config.chainId), config.permit2Address],
  ))
  if (domain !== domainHash('EVM Payment Channel', '1') || permitDomain !== domainHash('Permit2')) throw new Error('Deployed signing domains do not match the configured Nile network.')
  return { adapter, gracePeriod: grace }
}
/** Merchant authorizes settle/close; the configured relayer submits and pays resources. */
export function serverAdapter(config: SessionServerConfig, transport = nodeTransport(config, config.relayerPrivateKey), payeeSign?: TypedSigner): Session.Adapter {
  const adapter = createSessionAdapter(transport, config.escrowAddress, confirmations(config))
  const relay = createSessionRelayer(transport, config.escrowAddress, confirmations(config))
  const sign = payeeSign ?? nodeTransport(config, config.payeePrivateKey).signTypedData!
  const submit = async (action: 'settle' | 'close', channelId: Hex, cumulativeAmount: string, voucherSignature: Hex) => {
    const nonce = BigInt(randomHex()).toString(), deadline = String(Math.floor(Date.now() / 1000) + 300)
    const payeeSignature = await sign(payeeAuthorizationTypedData({ action, chainId: config.chainId, escrowContract: config.escrowAddress, channelId, cumulativeAmount, nonce, deadline }))
    return relay({ action, channelId, cumulativeAmount, nonce, deadline, voucherSignature, payeeSignature })
  }
  return { ...adapter, settle: (id, amount, signature) => submit('settle', id, amount, signature), close: (id, amount, signature) => submit('close', id, amount, signature) }
}
