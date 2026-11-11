import { tron } from 'tron-mpp-sdk/client'
import { createChargeAdapter, createTronWebTransport, type TronTransport } from 'tron-mpp-sdk/tronweb'
import { loadClientConfig, type ClientConfig } from './config.js'
import { createTronWeb } from './tron.js'

export function createPaymentClientMethod(
  config: ClientConfig = loadClientConfig(),
  transport: TronTransport = createTronWebTransport(createTronWeb({ ...config, privateKey: config.payerPrivateKey }), { chainId: config.chainId }),
) {
  const adapter = createChargeAdapter(transport, {
    timeoutMs: config.transactionTimeoutMs, pollIntervalMs: config.pollIntervalMs, minConfirmations: config.minConfirmations,
  })
  return { config, method: tron.charge({
    adapter, chainIds: [config.chainId], currencies: [config.tokenAddress], recipients: [config.recipientAddress],
    maxAtomicAmount: config.maxAtomicAmount, credentialTypes: [config.credentialType],
    ...(config.permit2 ? { permit2: config.permit2 } : {}),
  }) }
}
