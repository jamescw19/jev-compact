import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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

/** Decisions live under `<dataDir>/decisions/<transcript basename>/`. */
export function archiveDirFor(dataDir: string, transcriptPath: string): string {
  return path.join(dataDir, 'decisions', path.basename(transcriptPath))
}

function parseArchive(text: string): DecisionArchive | null {
  try {
    const parsed = JSON.parse(text) as Partial<DecisionArchive>
    if (parsed.version !== ARCHIVE_VERSION || !Array.isArray(parsed.items)) return null
    return parsed as DecisionArchive
  } catch {
    return null
  }
}

/** Write an archive atomically (tmp + rename) and return its path. */
export async function writeArchive(dataDir: string, archive: DecisionArchive): Promise<string> {
  const dir = archiveDirFor(dataDir, archive.transcriptPath)
  await mkdir(dir, { recursive: true })
  const stamp = archive.scoredAt.replace(/[:.]/g, '-')
  const finalPath = path.join(dir, `${stamp}-${process.pid}.json`)
  const tmpPath = `${finalPath}.tmp-${process.pid}`
  await writeFile(tmpPath, JSON.stringify(archive, null, 2) + '\n', 'utf8')
  await rename(tmpPath, finalPath)
  return finalPath
}

function isFresh(archive: DecisionArchive, ttlHours: number, now: number): boolean {
  const scoredAt = Date.parse(archive.scoredAt)
  if (Number.isNaN(scoredAt)) return false
  return now - scoredAt <= ttlHours * 3_600_000
}

/**
 * Find the freshest unconsumed archive for this session. Preference order:
 * same transcript basename (rollouts keep appending across compactions), then
 * a matching session_id. Only TTL-fresh archives qualify; `null` when none.
 */
export async function findLatestArchive(
  dataDir: string,
  sessionId: string,
  transcriptPath: string,
  ttlHours: number,
  now: number = Date.now(),
): Promise<ArchiveHit | null> {
  const candidates: string[] = []
  const preferredDir = archiveDirFor(dataDir, transcriptPath)
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
  await collect(preferredDir)
  // Fallback: compaction can continue under a different rollout file name,
  // so also look through every archive directory for this session.
  const root = path.join(dataDir, 'decisions')
  const dirEntries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of dirEntries) {
    if (entry.isDirectory()) await collect(path.join(root, entry.name))
  }

  let best: ArchiveHit | null = null
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    const consumed = await stat(`${candidate}.consumed`).then(
      () => true,
      () => false,
    )
    if (consumed) continue
    const archive = parseArchive(await readFile(candidate, 'utf8').catch(() => ''))
    if (archive === null || !isFresh(archive, ttlHours, now)) continue
    const sameTranscript = archive.transcriptPath === transcriptPath
    const sameSession = archive.sessionId === sessionId
    if (!sameTranscript && !sameSession) continue
    const scoredAt = Date.parse(archive.scoredAt)
    if (best !== null && scoredAt <= Date.parse(best.archive.scoredAt)) continue
    best = { archive, path: candidate }
  }
  return best
}

/** Mark an archive as consumed so a repeated SessionStart cannot re-inject. */
export async function markConsumed(archivePath: string): Promise<void> {
  await writeFile(`${archivePath}.consumed`, new Date().toISOString() + '\n', 'utf8')
}

/** Best-effort deletion of archives (and stale tmp files) past the TTL. */
export async function cleanupExpired(dataDir: string, ttlHours: number, now: number = Date.now()): Promise<void> {
  const root = path.join(dataDir, 'decisions')
  let dirs
  try {
    dirs = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    let files
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const file of files) {
      const full = path.join(dir, file)
      if (file.includes('.tmp-')) {
        await rm(full, { force: true }).catch(() => undefined)
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
