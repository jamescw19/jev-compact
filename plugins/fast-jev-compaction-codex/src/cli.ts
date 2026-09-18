import { resolveDataDir } from './config.js'
import { runProbe } from './probe.js'
import { readStdin } from './stdin.js'

export type HookEventName = 'pre-compact' | 'session-start'

function isHookEvent(value: string | undefined): value is HookEventName {
  return value === 'pre-compact' || value === 'session-start'
}

/**
 * Hook entrypoints. Until M3/M4 land they behave as recorders when
 * `FAST_JEV_RECORD=1` is set, and are strict no-ops otherwise — a hook must
 * never fail the host session, so every path exits 0 with a harmless payload.
 */
async function runHook(event: HookEventName): Promise<number> {
  if (process.env['FAST_JEV_RECORD'] === '1') {
    return runProbe(['record', event])
  }
  await readStdin()
  process.stdout.write('{}\n')
  return 0
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
    '',
    `data dir: ${resolveDataDir()}`,
  ].join('\n')
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (isHookEvent(command)) return runHook(command)
  if (command === 'probe') return runProbe(rest)
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage() + '\n')
    return 0
  }
  process.stderr.write(`${usage()}\n\nunknown command: ${command ?? '(none)'}\n`)
  return 0
}

const invokedDirectly = process.argv[1]?.includes('fast-jev')
if (invokedDirectly) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
