import { loadServerConfig } from './config.js'
import { createAppServer } from './app.js'

const config = loadServerConfig()
const server = createAppServer(config)
server.listen(config.port, '127.0.0.1', () => {
  console.log(`TRC-20 MPP test server listening at http://127.0.0.1:${config.port}`)
  console.log(`Paid endpoint: ${config.paymentAmountAtomic} token atomic units at /premium`)
  console.log(`Token contract: ${config.tokenAddress}`)
  console.log(`Recipient: ${config.recipientAddress}`)
  console.log(`Charge credential: ${config.credentialType}`)
  if (config.permit2) console.log(`Permit2: ${config.permit2.address}; relayer/spender: ${config.permit2.spender}`)
})

function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down.`)
  server.close(error => {
    if (error) { console.error(error); process.exitCode = 1 }
  })
}
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
