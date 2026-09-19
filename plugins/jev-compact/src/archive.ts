import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import type { CallAction } from './score.js'
import type { ToolCallKind } from './rollout/calls.js'

export interface ArchivedCallItem {
  readonly callId: string
  readonly kind: ToolCallKind
  readonly name: string
  readonly argumentsJson: string
  readonly outputText: string
  readonly outputChars: number
  readonly isError: boolean
  readonly callOrdinal: number
  readonly resultOrdinal: number
  readonly keepCall: number
  readonly keepResult: number
  readonly action: CallAction
  readonly pinned: boolean
}

export interface DecisionArchive {
  readonly version: 1
  readonly sessionId: string
  readonly turnId?: string
  readonly trigger: 'manual' | 'auto'
  readonly transcriptPath: string
  readonly transcriptBytesAtScore: number
  readonly scoredAt: string
  readonly model: string
  readonly stateStage: string
  readonly config: { readonly keepThreshold: number; readonly preserveRecentItems: number }
  readonly items: readonly ArchivedCallItem[]
}

export interface ArchiveHit {
  readonly archive: DecisionArchive
  readonly path: string
}

const ARCHIVE_VERSION = 1
/** Archives contain verbatim tool output — keep them private. */
const FILE_MODE = 0o600

/** Decisions live under `<dataDir>/decisions/<transcript basename>/`. */
export function archiveDirFor(dataDir: string, transcriptPath: string): string {
  return path.join(dataDir, 'decisions', path.basename(transcriptPath))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isAction(value: unknown): value is CallAction {
  return value === 'keep' || value === 'drop_result' || value === 'drop_call'
}

function parseItem(raw: unknown): ArchivedCallItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (typeof record['callId'] !== 'string' || record['callId'] === '') return null
  if (record['kind'] !== 'function_call' && record['kind'] !== 'custom_tool_call') return null
  if (typeof record['name'] !== 'string') return null
  if (typeof record['argumentsJson'] !== 'string') return null
  if (typeof record['outputText'] !== 'string') return null
  if (!isFiniteNumber(record['outputChars'])) return null
  if (!isFiniteNumber(record['callOrdinal']) || !isFiniteNumber(record['resultOrdinal'])) return null
  if (!isFiniteNumber(record['keepCall']) || !isFiniteNumber(record['keepResult'])) return null
  if (!isAction(record['action'])) return null
  if (typeof record['pinned'] !== 'boolean') return null
  return {
    callId: record['callId'],
    kind: record['kind'],
    name: record['name'],
    argumentsJson: record['argumentsJson'],
    outputText: record['outputText'],
    outputChars: record['outputChars'],
    isError: record['isError'] === true,
    callOrdinal: record['callOrdinal'],
    resultOrdinal: record['resultOrdinal'],
    keepCall: record['keepCall'],
    keepResult: record['keepResult'],
    action: record['action'],
    pinned: record['pinned'],
  }
}

/** Parse and fully validate an archive file; junk degrades to null. */
export function parseArchive(text: string): DecisionArchive | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (record['version'] !== ARCHIVE_VERSION) return null
  if (typeof record['sessionId'] !== 'string') return null
  if (typeof record['transcriptPath'] !== 'string') return null
  if (typeof record['scoredAt'] !== 'string' || Number.isNaN(Date.parse(record['scoredAt']))) return null
  if (!Array.isArray(record['items'])) return null
  const items: ArchivedCallItem[] = []
  for (const raw of record['items']) {
    const item = parseItem(raw)
    if (item === null) return null
    items.push(item)
  }
  return {
    version: ARCHIVE_VERSION,
    sessionId: record['sessionId'],
    turnId: typeof record['turnId'] === 'string' ? record['turnId'] : undefined,
    trigger: record['trigger'] === 'auto' ? 'auto' : 'manual',
    transcriptPath: record['transcriptPath'],
    transcriptBytesAtScore: isFiniteNumber(record['transcriptBytesAtScore']) ? record['transcriptBytesAtScore'] : 0,
    scoredAt: record['scoredAt'],
    model: typeof record['model'] === 'string' ? record['model'] : '',
    stateStage: typeof record['stateStage'] === 'string' ? record['stateStage'] : '',
    config: {
      keepThreshold: isFiniteNumber(record['keepThreshold']) ? (record['keepThreshold'] as number) : 0.5,
      preserveRecentItems: isFiniteNumber(record['preserveRecentItems'])
        ? (record['preserveRecentItems'] as number)
        : 8,
    },
    items,
  }
}

/** Write an archive atomically (tmp + rename) and return its path. */
export async function writeArchive(dataDir: string, archive: DecisionArchive): Promise<string> {
  const dir = archiveDirFor(dataDir, archive.transcriptPath)
  await mkdir(dir, { recursive: true })
  const stamp = archive.scoredAt.replace(/[:.]/g, '-')
  const finalPath = path.join(dir, `${stamp}-${process.pid}.json`)
  const tmpPath = `${finalPath}.tmp-${process.pid}`
  await writeFile(tmpPath, JSON.stringify(archive, null, 2) + '\n', { encoding: 'utf8', mode: FILE_MODE })
  await rename(tmpPath, finalPath)
  return finalPath
}

function isFresh(archive: DecisionArchive, ttlHours: number, now: number): boolean {
  const scoredAt = Date.parse(archive.scoredAt)
  if (Number.isNaN(scoredAt)) return false
  return now - scoredAt <= ttlHours * 3_600_000
}

async function listArchiveFiles(dataDir: string, transcriptPath: string): Promise<string[]> {
  const candidates: string[] = []
  const collect = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isFile() && entry.name.endsWith('.json')) candidates.push(full)
    }
  }
  await collect(archiveDirFor(dataDir, transcriptPath))
  // Fallback: compaction can continue under a different rollout file name,
  // so also look through every archive directory for this session.
  const root = path.join(dataDir, 'decisions')
  const dirEntries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of dirEntries) {
    if (entry.isDirectory()) await collect(path.join(root, entry.name))
  }
  return [...new Set(candidates)]
}

/**
 * Find the freshest unconsumed archive for this session. Archives matching
 * the transcript path win over session-only matches; within each tier the
 * newest `scoredAt` wins. Only TTL-fresh archives qualify; `null` when none.
 */
export async function findLatestArchive(
  dataDir: string,
  sessionId: string,
  transcriptPath: string,
  ttlHours: number,
  now: number = Date.now(),
): Promise<ArchiveHit | null> {
  let best: ArchiveHit | null = null
  for (const candidate of await listArchiveFiles(dataDir, transcriptPath)) {
    const archive = parseArchive(await readFile(candidate, 'utf8').catch(() => ''))
    if (archive === null || !isFresh(archive, ttlHours, now)) continue
    const sameTranscript = archive.transcriptPath === transcriptPath
    // 'unknown' must never match another session's 'unknown'.
    const sameSession =
      archive.sessionId === sessionId && sessionId !== 'unknown' && archive.sessionId !== 'unknown'
    if (!sameTranscript && !sameSession) continue
    if (await isConsumed(candidate)) continue
    if (best !== null) {
      const bestTier = best.archive.transcriptPath === transcriptPath ? 1 : 0
      const candidateTier = sameTranscript ? 1 : 0
      if (candidateTier < bestTier) continue
      if (candidateTier === bestTier && Date.parse(archive.scoredAt) <= Date.parse(best.archive.scoredAt))
        continue
    }
    best = { archive, path: candidate }
  }
  return best
}

async function isConsumed(archivePath: string): Promise<boolean> {
  return readFile(`${archivePath}.consumed`).then(
    () => true,
    () => false,
  )
}

/**
 * Atomically claim an archive for consumption via exclusive creation of the
 * `.consumed` sidecar. Returns false when another process claimed it first —
 * duplicate injection is merely noisy, so losing the race is a clean no-op.
 */
export async function claimArchive(archivePath: string): Promise<boolean> {
  try {
    await writeFile(`${archivePath}.consumed`, `${new Date().toISOString()}\n`, {
      encoding: 'utf8',
      mode: FILE_MODE,
      flag: 'wx',
    })
    return true
  } catch (error) {
    return (error as { code?: string }).code !== 'EEXIST'
  }
}

/** Best-effort deletion of archives (and stale tmp files) past the TTL. */
export async function cleanupExpired(dataDir: string, ttlHours: number, now: number = Date.now()): Promise<void> {
  const root = path.join(dataDir, 'decisions')
  const dirs = await readdir(root, { withFileTypes: true }).catch((): Dirent[] => [])
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const files = await readdir(dir).catch((): string[] => [])
    for (const file of files) {
      const full = path.join(dir, file)
      if (file.includes('.tmp-')) {
        await rm(full, { force: true }).catch(() => undefined)
        continue
      }
      if (file.endsWith('.consumed')) {
        // Drop orphan sidecars whose archive is already gone.
        if (!files.includes(file.replace(/\.consumed$/, '.json'))) {
          await rm(full, { force: true }).catch(() => undefined)
        }
        continue
      }
      if (!file.endsWith('.json')) continue
      const archive = parseArchive(await readFile(full, 'utf8').catch(() => ''))
      if (archive !== null && !isFresh(archive, ttlHours, now)) {
        await rm(full, { force: true }).catch(() => undefined)
        await rm(`${full}.consumed`, { force: true }).catch(() => undefined)
      }
    }
  }
}
