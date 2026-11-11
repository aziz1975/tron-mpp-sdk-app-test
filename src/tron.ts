import { TronWeb } from 'tronweb'

export function createTronWeb(options: { fullHost: string; privateKey?: string | undefined; tronProApiKey?: string | undefined }): TronWeb {
  return new TronWeb({
    fullHost: options.fullHost,
    ...(options.privateKey ? { privateKey: options.privateKey } : {}),
    ...(options.tronProApiKey ? { headers: { 'TRON-PRO-API-KEY': options.tronProApiKey } } : {}),
  })
}
