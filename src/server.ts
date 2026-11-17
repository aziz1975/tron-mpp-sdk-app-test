import { loadServerConfig } from './config.js'
import { createAppServer } from './app.js'
import { toBase58Address } from 'tron-mpp-sdk'

const config = loadServerConfig()
const server = createAppServer(config)
server.listen(config.port, '127.0.0.1', () => {
  console.log(`TRC-20 MPP test server listening at http://127.0.0.1:${config.port}`)
  console.log(`Paid endpoint: ${config.paymentAmountAtomic} token atomic units at /premium`)
  console.log(`Token contract: ${toBase58Address(config.tokenAddress)}`)
  console.log(`Recipient: ${toBase58Address(config.recipientAddress)}`)
  console.log(`Charge credential: ${config.credentialType}`)
  if (config.permit2) console.log(`Permit2: ${toBase58Address(config.permit2.address)}; relayer/spender: ${toBase58Address(config.permit2.spender)}`)
})

function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down.`)
  server.close(error => {
    if (error) { console.error(error); process.exitCode = 1 }
  })
}
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
