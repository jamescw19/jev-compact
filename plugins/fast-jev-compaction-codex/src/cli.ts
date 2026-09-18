import { pathToFileURL } from 'node:url'

import { loadConfig } from './config.js'
import type { FastJevConfig } from './config.js'
import { wirePayload } from './hooks/outcome.js'
import type { HookOutcome } from './hooks/outcome.js'
import { parsePreCompactInput, runPreCompact } from './hooks/pre-compact.js'
import { runSessionStart } from './hooks/session-start.js'
import { writeCapture } from './probe.js'
import { readStdin } from './stdin.js'

export type HookEventName = 'pre-compact' | 'session-start'

function isHookEvent(value: string | undefined): value is HookEventName {
  return value === 'pre-compact' || value === 'session-start'
}

function writeOutcome(outcome: HookOutcome): void {
  process.stdout.write(JSON.stringify(wirePayload(outcome)) + '\n')
}

/**
 * Hook entrypoints. Every failure path writes a harmless payload and exits 0
 * so the hook can never fail the host session. With `FAST_JEV_RECORD=1` each
 * invocation also tees its stdin to the probe directory for offline analysis.
 */
async function runHook(event: HookEventName): Promise<number> {
  // A broken stdout pipe must never surface as an unhandled error / nonzero exit.
  process.stdout.on('error', () => process.exit(0))
  let raw = ''
  try {
    raw = await readStdin()
  } catch (error) {
    process.stderr.write(`fast-jev: ${event} stdin unreadable: ${String(error)}\n`)
    writeOutcome({})
    return 0
  }
  try {
    if (process.env['FAST_JEV_RECORD'] === '1') {
      // Recording is diagnostics, not the mission — never let it fail the hook.
      await writeCapture(event, raw).catch((error: unknown) => {
        process.stderr.write(`fast-jev: probe capture failed: ${String(error)}\n`)
      })
    }
    const config: FastJevConfig = await loadConfig()
    let outcome: HookOutcome
    if (event === 'pre-compact') {
      const input = parsePreCompactInput(raw)
      outcome =
        input === null
          ? { note: 'fast-jev: unrecognized PreCompact payload' }
          : await runPreCompact(input, config)
    } else {
      outcome = await runSessionStart(raw, config)
    }
    if (outcome.note !== undefined && config.logLevel !== 'silent') {
      process.stderr.write(`${outcome.note}\n`)
    }
    writeOutcome(outcome)
    return 0
  } catch (error) {
    process.stderr.write(`fast-jev: ${event} degraded to no-op: ${String(error)}\n`)
    writeOutcome({})
    return 0
  }
}

function usage(): string {
  return [
    'fast-jev-compaction-codex',
    '',
    'usage:',
    '  fast-jev.mjs pre-compact          PreCompact hook entrypoint',
    '  fast-jev.mjs session-start        SessionStart hook entrypoint',
    '  fast-jev.mjs probe record <Event> capture stdin+env to the data dir',
    '  fast-jev.mjs probe inspect <file> normalize a captured record',
    '  fast-jev.mjs probe ls             list captured records',
  ].join('\n')
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (isHookEvent(command)) return runHook(command)
  if (command === 'probe') {
    const { runProbe } = await import('./probe.js')
    return runProbe(rest)
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage() + '\n')
    return 0
  }
  process.stderr.write(`${usage()}\n\nunknown command: ${command ?? '(none)'}\n`)
  return 0
}

// Only auto-run when this file is the process entry module (bundled dist or
// direct TS execution) — importing the module must never exit the host.
const entryPath = process.argv[1]
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  const code = await main(process.argv.slice(2))
  // Set the exit code and let the process end naturally: process.exit() can
  // truncate buffered stdout on pipes (the host reads hooks through a pipe),
  // which would hand Codex half a JSON payload.
  process.exitCode = code
}
