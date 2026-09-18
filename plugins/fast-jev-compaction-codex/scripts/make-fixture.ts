import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_OUT = 'test/fixtures/rollout-compacted-sample.jsonl'
const BEFORE = 20
const AFTER = 40
const MAX_STRING = 400
const REDACTED = '"[REDACTED]"'

async function* rolloutFiles(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* rolloutFiles(full)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.startsWith('rollout-')) {
      yield full
    }
  }
}

function walkRedact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walkRedact)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        key === 'encrypted_content' ? JSON.parse(REDACTED) : walkRedact(child),
      ]),
    )
  }
  if (typeof value === 'string') {
    const text = value.split(os.homedir()).join('/Users/dev')
    return text.length <= MAX_STRING
      ? text
      : `${text.slice(0, MAX_STRING)}…[+${text.length - MAX_STRING} chars]`
  }
  return value
}

function redactLine(line: string): string | null {
  try {
    return JSON.stringify(walkRedact(JSON.parse(line)))
  } catch {
    return null
  }
}

async function findLatestCompactedRollout(): Promise<string | null> {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  let best: { file: string; mtime: number } | null = null
  for await (const file of rolloutFiles(root)) {
    const content = await readFile(file, 'utf8').catch(() => null)
    if (content === null || !content.includes('"type":"compacted"')) continue
    const info = await stat(file)
    if (best === null || info.mtimeMs > best.mtime) best = { file, mtime: info.mtimeMs }
  }
  return best?.file ?? null
}

async function main(): Promise<void> {
  const source = await findLatestCompactedRollout()
  if (source === null) {
    process.stderr.write('make-fixture: no rollout containing a compacted record was found\n')
    process.exit(1)
  }
  const content = await readFile(source, 'utf8')
  const lines = content.split('\n')
  const at = lines.findIndex((line) => line.includes('"type":"compacted"'))
  const kept: string[] = []
  for (let index = Math.max(0, at - BEFORE); index <= Math.min(lines.length - 1, at + AFTER); index += 1) {
    const redacted = redactLine(lines[index] ?? '')
    if (redacted !== null) kept.push(redacted)
  }
  await mkdir(path.dirname(DEFAULT_OUT), { recursive: true })
  await writeFile(DEFAULT_OUT, kept.join('\n') + '\n', 'utf8')
  process.stdout.write(
    `make-fixture: wrote ${kept.length} redacted lines around line ${at + 1} of ${source}\n` +
      `make-fixture: -> ${DEFAULT_OUT}\n`,
  )
}

await main()
