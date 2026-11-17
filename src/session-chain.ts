import { createConfiguredSession } from 'tron-mpp-sdk/session'
import { parseAbi, type Hex } from 'viem'
import { Session, type TypedSigner } from 'tron-mpp-sdk'
import { createTronWebTransport, type TronTransport } from 'tron-mpp-sdk/tronweb'
import { randomBytes } from 'node:crypto'
import { createTronWeb } from './tron.js'
import type { SessionConfig, SessionServerConfig } from './session-config.js'

export const randomHex = (): Hex => `0x${randomBytes(32).toString('hex')}`
export const confirmations = (config: SessionConfig) => ({ timeoutMs: config.transactionTimeoutMs, pollIntervalMs: config.pollIntervalMs, minConfirmations: config.minConfirmations })
export const sessionViews = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function nonceBitmap(address,uint256) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
])
export function nodeTransport(config: SessionConfig, privateKey?: string) {
  return createTronWebTransport(createTronWeb({ ...config, ...(privateKey ? { privateKey } : {}) }), { chainId: config.chainId })
}
/** Build an SDK session; escrow resolution and all escrow operations stay in the SDK. */
export function configuredSession(config: SessionConfig, transport: TronTransport) {
  return createConfiguredSession(transport, { ...confirmations(config), currency: config.tokenAddress, permit2Contract: config.permit2Address })
}
/** Merchant authorizes settle/close; the configured relayer submits and pays resources. */
export function serverAdapter(config: SessionServerConfig, transport = nodeTransport(config, config.relayerPrivateKey), payeeSign?: TypedSigner): Session.Adapter {
  const sign = payeeSign ?? nodeTransport(config, config.payeePrivateKey).signTypedData!
  return configuredSession(config, transport).serverAdapter(sign)
}
