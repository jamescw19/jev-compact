import os from 'node:os'
import path from 'node:path'

/** Environment variables a plugin-provided data dir may arrive under. */
const PLUGIN_DATA_KEYS = ['PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA'] as const

/** Environment variables a plugin-provided root dir may arrive under. */
export const PLUGIN_ROOT_KEYS = ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT'] as const

/**
 * Resolve the writable data directory used for decision archives, probe
 * captures, and logs.
 *
 * Order: `$PLUGIN_DATA` (set by Codex for plugin hooks) →
 * `$CODEX_HOME/fast-jev-compaction-data` → `~/.codex/fast-jev-compaction-data`.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  for (const key of PLUGIN_DATA_KEYS) {
    const value = env[key]
    if (value && value.trim() !== '') return value
  }
  return path.join(resolveCodexHome(env), 'fast-jev-compaction-data')
}

/** Resolve `$CODEX_HOME`, defaulting to `~/.codex`. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const value = env['CODEX_HOME']
  if (value && value.trim() !== '') return value
  return path.join(os.homedir(), '.codex')
}

/** First non-empty value among plugin root env aliases, if any. */
export function resolvePluginRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of PLUGIN_ROOT_KEYS) {
    const value = env[key]
    if (value && value.trim() !== '') return value
  }
  return null
}
