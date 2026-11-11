import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Store } from 'mppx'

export function readJson(path: string): unknown | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor) }
  finally { closeSync(descriptor) }
  try { renameSync(temporary, path) }
  finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
/** One process owns each local journal. Stale locks are recovered only after its PID exits. */
export function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      writeFileSync(fd, String(process.pid)); closeSync(fd)
      let released = false
      return () => { if (!released) { unlinkSync(path); released = true } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const pid = Number(readFileSync(path, 'utf8'))
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Invalid lock: ${path}`)
      try { process.kill(pid, 0); throw new Error(`Another process owns ${path} (PID ${pid}).`) }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure }
      unlinkSync(path)
    }
  }
  throw new Error(`Cannot acquire lock: ${path}`)
}
/** File persistence plus serialized atomic updates for this single-process harness. */
export function fileStore(path: string): Store.AtomicStore {
  const existing = readJson(path)
  if (existing !== null && (typeof existing !== 'object' || Array.isArray(existing))) throw new Error('Invalid session server journal.')
  let data = (existing ?? {}) as Record<string, unknown>
  let tail = Promise.resolve()
  const update: Store.Update = (key, fn) => {
    const run = tail.then(() => {
      const change = fn(structuredClone(data[key] ?? null))
      if (change.op !== 'noop') {
        const next = { ...data }
        if (change.op === 'set') next[key] = structuredClone(change.value)
        else delete next[key]
        writeJson(path, next)
        data = next
      }
      return structuredClone(change.result)
    })
    tail = run.then(() => {}, () => {})
    return run
  }
  return { update, get: async key => { await tail; return structuredClone(data[key] ?? null) },
    put: (key, value) => update(key, () => ({ op: 'set', value, result: undefined })),
    delete: key => update(key, () => ({ op: 'delete', result: undefined })),
  }
}
