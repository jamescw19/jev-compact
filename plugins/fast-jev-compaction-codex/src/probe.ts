import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveDataDir } from './config.js'
import { readStdin } from './stdin.js'

const ENV_KEYS = [
  'PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
  'PLUGIN_DATA',
  'CLAUDE_PLUGIN_DATA',
  'CODEX_HOME',
  'HOME',
  'PATH',
]

export interface ProbeRecord {
  capturedAt: string
  pid: number
  ppid: number
  cwd: string
  event: string
  argv: readonly string[]
  env: Record<string, string>
  stdinRaw: string
  stdinJson: unknown
}

function sanitizeEventName(event: string): string {
  return event.replace(/[^A-Za-z0-9_-]/g, '-') || 'unknown'
}

function snapshotEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const key of ENV_KEYS) {
    const value = env[key]
    if (value !== undefined) snapshot[key] = value
  }
  for (const key of Object.keys(env)) {
    if (/^(PLUGIN|CODEX|CLAUDE|FAST_JEV)/i.test(key) && !(key in snapshot)) {
      snapshot[key] = env[key] ?? ''
    }
  }
  return snapshot
}

/** Tee a raw stdin capture to `<dataDir>/probe/` and return the file path. */
export async function writeCapture(event: string, stdinRaw: string): Promise<string> {
  const record: ProbeRecord = {
    capturedAt: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    event,
    argv: process.argv.slice(2),
    env: snapshotEnv(process.env),
    stdinRaw,
    stdinJson: parseSafeJson(stdinRaw),
  }
  const dir = path.join(resolveDataDir(), 'probe')
  await mkdir(dir, { recursive: true })
  const stamp = record.capturedAt.replace(/[:.]/g, '-')
  const file = path.join(dir, `${stamp}-${sanitizeEventName(event)}-${process.pid}.json`)
  await writeFile(file, JSON.stringify(record, null, 2) + '\n', 'utf8')
  process.stderr.write(`fast-jev probe: captured ${event} -> ${file}\n`)
  return file
}

/** `probe record <Event>` — tee stdin + environment to a JSON file for offline analysis. */
async function record(event: string): Promise<number> {
  const stdinRaw = await readStdin()
  await writeCapture(event, stdinRaw)
  return 0
}

function parseSafeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** `probe inspect <file...>` — print normalized fields from captured records. */
async function inspect(files: readonly string[]): Promise<number> {
  for (const file of files) {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      process.stderr.write(`fast-jev probe: cannot read ${file}: ${String(error)}\n`)
      continue
    }
    const parsed = parseSafeJson(raw) as Partial<ProbeRecord> | null
    if (parsed === null) {
      process.stderr.write(`fast-jev probe: ${file} is not JSON\n`)
      continue
    }
    process.stdout.write(`=== ${path.basename(file)} ===\n`)
    process.stdout.write(`event: ${parsed.event}\n`)
    process.stdout.write(`capturedAt: ${parsed.capturedAt}\n`)
    process.stdout.write(`cwd: ${parsed.cwd}\n`)
    process.stdout.write(
      `env: ${JSON.stringify(Object.fromEntries(Object.entries(parsed.env ?? {}).filter(([k]) => k !== 'PATH')), null, 2)}\n`,
    )
    process.stdout.write(`stdin:\n${JSON.stringify(parsed.stdinJson, null, 2)}\n`)
    const stdin = parsed.stdinJson as { transcript_path?: string } | null
    const transcriptPath = stdin?.transcript_path
    if (typeof transcriptPath === 'string' && transcriptPath !== '') {
      try {
        const info = await stat(transcriptPath)
        process.stdout.write(
          `transcript: exists (${info.size} bytes) at capture time? (checked now)\n`,
        )
      } catch {
        process.stdout.write(`transcript: NOT FOUND now (${transcriptPath})\n`)
      }
    }
  }
  return 0
}

/** `probe ls` — list captured records, oldest first. */
async function list(): Promise<number> {
  const dir = path.join(resolveDataDir(), 'probe')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    process.stdout.write('(no probe captures yet)\n')
    return 0
  }
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const full = path.join(dir, entry)
    const info = await stat(full)
    process.stdout.write(`${entry}  (${info.size} bytes)\n`)
  }
  return 0
}

/** Dispatch `probe ...` subcommands. Always exits 0 — probes must never fail a session. */
export async function runProbe(args: readonly string[]): Promise<number> {
  const [action, ...rest] = args
  switch (action) {
    case 'record':
      return record(rest[0] ?? 'unknown')
    case 'inspect':
      return inspect(rest)
    case 'ls':
      return list()
    default:
      process.stderr.write('usage: fast-jev.mjs probe record <Event> | inspect <file...> | ls\n')
      return 0
  }
}
