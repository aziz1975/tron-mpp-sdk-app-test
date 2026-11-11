import { join } from 'node:path'
import { loadSessionClientConfig } from './session-config.js'
import { SessionTestClient, type SessionAction } from './session-payment-client.js'
import { acquireLock } from './session-storage.js'

async function main() {
  const action = process.argv[2] ?? 'inspect', amount = process.argv[3]
  const allowed = ['inspect', 'challenge', 'approve', 'revoke', 'open', 'voucher', 'topUp', 'merge', 'pay', 'stream', 'settle', 'close', 'retry', 'replay', 'reconcile', 'requestClose', 'withdraw']
  if (!allowed.includes(action)) throw new Error(`Choose one of: ${allowed.join(', ')}`)
  const config = loadSessionClientConfig(), release = acquireLock(join(config.stateDir, 'client.lock'))
  try {
    const client = new SessionTestClient(config)
    console.log(`Session action: ${action}; endpoint: ${config.serverUrl}/session`)
    let result: unknown
    if (action === 'inspect') result = await client.inspect()
    else if (action === 'challenge') { result = await client.challenge(); console.log('Challenge inspected without signing or broadcasting.') }
    else if (action === 'approve' || action === 'revoke') result = await client.approve(action === 'revoke')
    else if (action === 'settle' || action === 'reconcile') result = await client.operator(action, process.env.MPP_SECRET_KEY?.trim() ?? '')
    else if (action === 'requestClose' || action === 'withdraw') result = await client.force(action)
    else if (action === 'retry') result = await client.retry()
    else if (action === 'replay') result = await client.replay()
    else result = await client.execute(action as SessionAction, amount)
    console.log(JSON.stringify(result, null, 2))
    if (result && typeof result === 'object' && 'status' in result && Number(result.status) >= 400) process.exitCode = 1
    if (client.pending) console.log('Operation retained in the client journal. Retry/reconcile this operation before creating another payment.')
  } finally { release() }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Session test failed.'); process.exitCode = 1 })
