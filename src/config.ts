import { chains, normalizeAddress, TokenAddressSchema } from 'tron-mpp-sdk'
import { TronWeb } from 'tronweb'
import type { Address } from 'viem'

const privateKeyPattern = /^(?:0x)?[0-9a-fA-F]{64}$/

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`)
  return value
}

function address(name: string, token = false): Address {
  const value = required(name)
  try { return token ? TokenAddressSchema.parse(value) : normalizeAddress(value) }
  catch { throw new Error(`${name} must be a valid ${token ? 'nonzero TRON' : 'TRON'} address.`) }
}

function atomicAmount(name: string, fallback: string): string {
  const raw = process.env[name]?.trim() || fallback
  if (!/^[1-9]\d*$/.test(raw) || BigInt(raw) >= 1n << 256n) throw new Error(`${name} must be a positive uint256 integer in token atomic units.`)
  return raw
}

function privateKey(name: string): string {
  const key = required(name)
  if (!privateKeyPattern.test(key)) throw new Error(`${name} must be a 32-byte hex key.`)
  return key.replace(/^0x/, '')
}

export function loadSharedConfig() {
  const port = positiveInteger('PORT', 3000)
  if (port > 65535) throw new Error('PORT must be at most 65535.')
  const credentialType = process.env.CHARGE_CREDENTIAL_TYPE?.trim() || 'transaction'
  if (credentialType !== 'transaction' && credentialType !== 'permit2') throw new Error('CHARGE_CREDENTIAL_TYPE must be transaction or permit2.')
  const permit2 = credentialType === 'permit2' ? {
    address: address('TRON_PERMIT2_ADDRESS', true),
    spender: address('TRON_PERMIT2_SPENDER_ADDRESS', true),
  } : undefined
  return {
    credentialType: credentialType as 'transaction' | 'permit2',
    permit2,
    chainId: chains.nile,
    fullHost: process.env.TRON_FULL_HOST?.trim() || 'https://nile.trongrid.io',
    tronProApiKey: process.env.TRON_PRO_API_KEY?.trim() || undefined,
    tokenAddress: address('TRON_TOKEN_ADDRESS', true),
    recipientAddress: address('TRON_RECIPIENT_ADDRESS'),
    transactionTimeoutMs: positiveInteger('TRANSACTION_TIMEOUT_MS', 90000),
    pollIntervalMs: positiveInteger('POLL_INTERVAL_MS', 1000),
    minConfirmations: positiveInteger('MIN_CONFIRMATIONS', 1),
    port,
  }
}

export function loadServerConfig() {
  if (process.env.PAYMENT_AMOUNT_TRX?.trim()) throw new Error('PAYMENT_AMOUNT_TRX is no longer supported. Use PAYMENT_AMOUNT_ATOMIC and TRON_TOKEN_ADDRESS.')
  const shared = loadSharedConfig()
  const relayerPrivateKey = shared.permit2 ? privateKey('TRON_RELAYER_PRIVATE_KEY') : undefined
  if (relayerPrivateKey && normalizeAddress(TronWeb.address.fromPrivateKey(relayerPrivateKey) || '') !== shared.permit2?.spender) {
    throw new Error('TRON_RELAYER_PRIVATE_KEY must belong to TRON_PERMIT2_SPENDER_ADDRESS.')
  }
  return {
    ...shared,
    relayerPrivateKey,
    mppSecretKey: required('MPP_SECRET_KEY'),
    paymentAmountAtomic: atomicAmount('PAYMENT_AMOUNT_ATOMIC', '1000000'),
  }
}

export function loadClientConfig() {
  const shared = loadSharedConfig()
  return {
    ...shared,
    payerPrivateKey: privateKey('TRON_PAYER_PRIVATE_KEY'),
    maxAtomicAmount: atomicAmount('MAX_PAYMENT_AMOUNT_ATOMIC', '1000000'),
    serverUrl: `http://127.0.0.1:${shared.port}`,
  }
}

export type ServerConfig = ReturnType<typeof loadServerConfig>
export type ClientConfig = ReturnType<typeof loadClientConfig>
