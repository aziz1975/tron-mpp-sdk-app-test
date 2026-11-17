import { toBase58Address } from 'tron-mpp-sdk'

const addressFields = new Set([
  'address', 'payer', 'payee', 'recipient', 'owner', 'from', 'to', 'token', 'currency',
  'escrow', 'permit2', 'spender', 'authorizedSigner', 'verifyingContract',
  'escrowContract', 'permit2Contract', 'owner_address', 'contract_address',
  'currencies', 'recipients', 'escrowContracts',
])

/** Convert a copy for console display; never use this result for signing or storage. */
export function addressesForDisplay(value: unknown, field = ''): unknown {
  if (typeof value === 'string') {
    if (addressFields.has(field) || field.endsWith('Address')) {
      try { return toBase58Address(value) } catch { return value }
    }
    if (field === 'body') return responseTextForDisplay(value)
    return value
  }
  if (Array.isArray(value)) return value.map(item => addressesForDisplay(item, field))
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, addressesForDisplay(item, key)]))
  }
  return value
}

export function jsonForDisplay(value: unknown) {
  return JSON.stringify(addressesForDisplay(value), null, 2)
}

export function responseTextForDisplay(text: string): string {
  try { return JSON.stringify(addressesForDisplay(JSON.parse(text))) }
  catch { return text }
}
