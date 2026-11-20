import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_DECISION_MODEL } from './jev/types.js'

/** Environment variables a plugin-provided data dir may arrive under. */
const PLUGIN_DATA_KEYS = ['PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA'] as const

/** Environment variables a plugin-provided root dir may arrive under. */
export const PLUGIN_ROOT_KEYS = ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT'] as const

export type LogLevel = 'debug' | 'info' | 'silent'

export interface FastJevConfig {
  readonly apiKey: string | null
  readonly model: string
  readonly baseUrl: string | null
  readonly keepThreshold: number
  readonly preserveRecentItems: number
  readonly maxStateTokens: number
  readonly maxRequestTokens: number
  readonly jevRequestTimeoutMs: number
  readonly jevDeadlineMs: number
  readonly maxBackfillChars: number
  readonly perItemChars: number
  readonly archiveTtlHours: number
  readonly dataDir: string | null
  readonly logLevel: LogLevel
}

export const DEFAULT_CONFIG: FastJevConfig = {
  apiKey: null,
  model: DEFAULT_DECISION_MODEL,
  baseUrl: null,
  keepThreshold: 0.5,
  preserveRecentItems: 8,
  maxStateTokens: 25000,
  maxRequestTokens: 30000,
  jevRequestTimeoutMs: 60_000,
  jevDeadlineMs: 240_000,
  maxBackfillChars: 8000,
  perItemChars: 4000,
  archiveTtlHours: 2,
  dataDir: null,
  logLevel: 'info',
}

/** Resolve `$CODEX_HOME`, defaulting to `~/.codex`. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const value = env['CODEX_HOME']
  if (value === undefined || value.trim() === '') return path.join(os.homedir(), '.codex')
  return value
}

/** Path of the optional config file inside the Codex home. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveCodexHome(env), 'fast-jev-compaction.json')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function coerceNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return clamp(value, min, max)
}

/**
 * Parse config file JSON. Unknown keys are ignored and every field falls
 * back to its default when missing or malformed — a broken config file must
 * never break a session.
 */
export function parseConfigJson(text: string, base: FastJevConfig = DEFAULT_CONFIG): FastJevConfig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return base
  }
  if (typeof raw !== 'object' || raw === null) return base
  const record = raw as Record<string, unknown>
  const logLevel = record['logLevel']
  return {
    apiKey: optionalString(record['apiKey']),
    model: optionalString(record['model']) ?? base.model,
    baseUrl: optionalString(record['baseUrl']),
    keepThreshold: coerceNumber(record['keepThreshold'], base.keepThreshold, 0.01, 1),
    preserveRecentItems: Math.round(
      coerceNumber(record['preserveRecentItems'], base.preserveRecentItems, 0, 500),
    ),
    maxStateTokens: Math.round(coerceNumber(record['maxStateTokens'], base.maxStateTokens, 1000, 200_000)),
    maxRequestTokens: Math.round(
      coerceNumber(record['maxRequestTokens'], base.maxRequestTokens, 2000, 32_000),
    ),
    jevRequestTimeoutMs: Math.round(
      coerceNumber(record['jevRequestTimeoutMs'], base.jevRequestTimeoutMs, 1000, 600_000),
    ),
    jevDeadlineMs: Math.round(coerceNumber(record['jevDeadlineMs'], base.jevDeadlineMs, 1000, 590_000)),
    maxBackfillChars: Math.round(coerceNumber(record['maxBackfillChars'], base.maxBackfillChars, 0, 60_000)),
    perItemChars: Math.round(coerceNumber(record['perItemChars'], base.perItemChars, 0, 30_000)),
    archiveTtlHours: coerceNumber(record['archiveTtlHours'], base.archiveTtlHours, 0.1, 168),
    dataDir: optionalString(record['dataDir']),
    logLevel: logLevel === 'debug' || logLevel === 'silent' ? logLevel : 'info',
  }
}

/** Load config: defaults ← config file ← `GEMINI_API_KEY` env override. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<FastJevConfig> {
  let config = DEFAULT_CONFIG
  try {
    config = parseConfigJson(await readFile(configPath(env), 'utf8'))
  } catch {
    // No config file (or unreadable) — defaults are fine.
  }
  const envKey = env['GEMINI_API_KEY']
  if (envKey !== undefined && envKey.trim() !== '') {
    config = { ...config, apiKey: envKey.trim() }
  }
  // The state rides inside every request; a state budget at or above the
  // request budget degenerates batching to one call per request.
  const stateCeiling = config.maxRequestTokens - 1024
  if (config.maxStateTokens > stateCeiling) {
    config = { ...config, maxStateTokens: Math.max(1000, stateCeiling) }
  }
  return config
}

/**
 * Writable data directory for archives/probe captures/logs:
 * configured `dataDir` → `$PLUGIN_DATA` → `$CODEX_HOME/fast-jev-compaction-data`.
 */
export function resolveDataDir(config?: FastJevConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (config !== undefined && config.dataDir !== null) return config.dataDir
  for (const key of PLUGIN_DATA_KEYS) {
    const value = env[key]
    if (value !== undefined && value.trim() !== '') return value
  }
  return path.join(resolveCodexHome(env), 'fast-jev-compaction-data')
}

/** First non-empty value among plugin root env aliases, if any. */
export function resolvePluginRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of PLUGIN_ROOT_KEYS) {
    const value = env[key]
    if (value !== undefined && value.trim() !== '') return value
  }
  return null
}
