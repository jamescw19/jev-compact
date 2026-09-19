import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Best-effort JSONL diagnostic log under `<dataDir>/log/fast-jev.log`.
 * Never throws — logging must not affect hook outcomes.
 */
export async function appendLog(dataDir: string, entry: Record<string, unknown>): Promise<void> {
  try {
    const dir = path.join(dataDir, 'log')
    await mkdir(dir, { recursive: true })
    const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })
    await appendFile(path.join(dir, 'fast-jev.log'), line + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch {
    // ignore — diagnostics only
  }
}
