import { loadSessionServerConfig } from './session-config.js'
import { createSessionApp } from './session-app.js'

const config = loadSessionServerConfig()
const { server } = await createSessionApp(config)
server.once('error', error => { console.error(error.message); process.exitCode = 1 })
server.listen(config.port, '127.0.0.1', () => {
  console.log(`Permit2 session server: ${config.serverUrl}/session`)
  console.log(`Escrow: ${config.escrowAddress}; payee: ${config.recipientAddress}`)
  console.log(`Unit price: ${config.unitAmount} atomic units; journal: ${config.stateDir}`)
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(); server.closeAllConnections() })
