import { resolve } from 'node:path'
import { TronWeb } from 'tronweb'
import { chains, TokenAddressSchema, Uint128Schema } from 'tron-mpp-sdk'

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}
function address(name: string) { return TokenAddressSchema.parse(required(name)) }
function amount(name: string, fallback: string) {
  const value = Uint128Schema.parse(process.env[name]?.trim() || fallback)
  if (BigInt(value) === 0n) throw new Error(`${name} must be positive token atomic units.`)
  return value
}
function integer(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]?.trim() || fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be between 1 and ${maximum}.`)
  return value
}
function key(name: string) {
  const value = required(name).replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{64}$/.test(value) || !TronWeb.address.fromPrivateKey(value)) throw new Error(`${name} must be a valid 32-byte private key.`)
  return value
}
export function loadSessionConfig() {
  const credentialType = process.env.CREDENTIAL_TYPE?.trim() || 'transaction'
  if (credentialType !== 'permit2') throw new Error('CREDENTIAL_TYPE must be permit2 for session; other session credential types are not implemented by this app.')
  const port = integer('SESSION_PORT', 3001, 65535)
  const unitAmount = amount('SESSION_UNIT_AMOUNT_ATOMIC', '100000')
  const deposit = amount('SESSION_DEPOSIT_ATOMIC', '1000000')
  const topUp = amount('SESSION_TOP_UP_ATOMIC', '1000000')
  const maxDeposit = amount('SESSION_MAX_DEPOSIT_ATOMIC', '2000000')
  const maxCumulative = amount('SESSION_MAX_CUMULATIVE_ATOMIC', '2000000')
  if (BigInt(deposit) < BigInt(unitAmount) || BigInt(deposit) > BigInt(maxDeposit) || BigInt(topUp) > BigInt(maxDeposit)) throw new Error('Session deposit/top-up settings exceed policy or do not cover one unit.')
  if (BigInt(maxCumulative) < BigInt(unitAmount)) throw new Error('SESSION_MAX_CUMULATIVE_ATOMIC must cover one unit.')
  return { credentialType: credentialType as 'permit2', chainId: chains.nile, port, serverUrl: `http://127.0.0.1:${port}`,
    fullHost: process.env.TRON_FULL_HOST?.trim() || 'https://nile.trongrid.io',
    tronProApiKey: process.env.TRON_PRO_API_KEY?.trim() || undefined,
    tokenAddress: address('TRON_TOKEN_ADDRESS'), recipientAddress: address('TRON_RECIPIENT_ADDRESS'),
    escrowAddress: address('TRON_SESSION_ESCROW_ADDRESS'), permit2Address: address('TRON_PERMIT2_ADDRESS'),
    stateDir: resolve(process.env.SESSION_STATE_DIR?.trim() || '.data/session'),
    unitAmount, deposit, topUp, maxDeposit, maxCumulative,
    streamUnits: integer('SESSION_STREAM_UNITS', 4, 100),
    transactionTimeoutMs: integer('TRANSACTION_TIMEOUT_MS', 90000),
    pollIntervalMs: integer('POLL_INTERVAL_MS', 1000), minConfirmations: integer('MIN_CONFIRMATIONS', 1),
  }
}
export function loadSessionClientConfig() {
  const shared = loadSessionConfig(), payerPrivateKey = key('TRON_PAYER_PRIVATE_KEY')
  return { ...shared, payerPrivateKey, payer: TokenAddressSchema.parse(TronWeb.address.fromPrivateKey(payerPrivateKey)) }
}
export function loadSessionServerConfig() {
  const shared = loadSessionConfig(), relayerPrivateKey = key('TRON_RELAYER_PRIVATE_KEY')
  const payeePrivateKey = process.env.TRON_PAYEE_PRIVATE_KEY?.trim() ? key('TRON_PAYEE_PRIVATE_KEY') : relayerPrivateKey
  if (TokenAddressSchema.parse(TronWeb.address.fromPrivateKey(payeePrivateKey)) !== shared.recipientAddress) throw new Error('Set TRON_PAYEE_PRIVATE_KEY for TRON_RECIPIENT_ADDRESS, or use that wallet as the relayer.')
  const mppSecretKey = required('MPP_SECRET_KEY')
  if (mppSecretKey.length < 16) throw new Error('MPP_SECRET_KEY must contain at least 16 characters.')
  return { ...shared, relayerPrivateKey, payeePrivateKey, mppSecretKey }
}
export type SessionConfig = ReturnType<typeof loadSessionConfig>
export type SessionClientConfig = ReturnType<typeof loadSessionClientConfig>
export type SessionServerConfig = ReturnType<typeof loadSessionServerConfig>
