import { claimArchive, findLatestArchive } from '../archive.js'
import { buildAdditionalContext, collectCandidates, rankAndFit } from '../backfill.js'
import { resolveDataDir } from '../config.js'
import type { FastJevConfig } from '../config.js'
import { effectiveHistory, parseTranscriptFile } from '../rollout/index.js'
import type { StampedHistory } from '../ir.js'
import type { HookOutcome } from './outcome.js'

export interface SessionStartInput {
  readonly sessionId: string
  readonly source: string
  /** Optional: hooks payloads without it degrade to session-id-only matching. */
  readonly transcriptPath?: string
}

/** Short input digest carried by drop_result call notes. */
const CALL_NOTE_CHARS = 300

/** Parse the SessionStart hook stdin payload, tolerating missing fields. */
export function parseSessionStartInput(raw: string): SessionStartInput | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const sessionId = typeof record['session_id'] === 'string' ? record['session_id'] : 'unknown'
  const source = typeof record['source'] === 'string' ? record['source'] : 'unknown'
  const transcriptPath =
    typeof record['transcript_path'] === 'string' && record['transcript_path'] !== ''
      ? record['transcript_path']
      : undefined
  return { sessionId, source, transcriptPath }
}

/**
 * SessionStart(source=compact) hook body: find the archive the PreCompact
 * hook wrote, check which scored-critical outputs the built-in summary
 * actually lost, and re-inject them verbatim via `additionalContext`.
 * Anything other than a compaction start is a no-op. The archive is claimed
 * only after the outcome is fully constructed — duplicate injection is
 * harmless, losing the content is not.
 */
export async function runSessionStart(
  raw: string,
  config: FastJevConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutcome> {
  const input = parseSessionStartInput(raw)
  if (input === null || input.source !== 'compact') {
    return { note: 'fast-jev: session start without compaction; nothing to do' }
  }
  const dataDir = resolveDataDir(config, env)
  const hit = await findLatestArchive(
    dataDir,
    input.sessionId,
    input.transcriptPath ?? '',
    config.archiveTtlHours,
  )
  if (hit === null) {
    return { note: 'fast-jev: no fresh archive for this compaction' }
  }

  // If the transcript does not reflect the compaction yet (record not
  // flushed), membership checks would wrongly report "everything present".
  // Leave the archive unclaimed and say so.
  let history: readonly StampedHistory[] = []
  if (input.transcriptPath !== undefined) {
    const { transcript } = await parseTranscriptFile(input.transcriptPath)
    if (transcript.lastCompacted === undefined) {
      return { note: 'fast-jev: transcript has no compaction record yet; skipping to avoid false negatives' }
    }
    history = effectiveHistory(transcript)
  } else {
    history = []
  }

  const candidates = collectCandidates(hit.archive, history, CALL_NOTE_CHARS)
  if (candidates.length === 0) {
    await claimArchive(hit.path)
    return { note: 'fast-jev: archive processed; the summary kept everything that mattered' }
  }
  const fitted = rankAndFit(candidates, config.maxBackfillChars, config.perItemChars)
  if (fitted.length === 0) {
    await claimArchive(hit.path)
    return { note: 'fast-jev: backfill candidates exceeded the character budget' }
  }
  const outcome: HookOutcome = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: buildAdditionalContext(fitted, candidates.length),
    },
  }
  await claimArchive(hit.path)
  return outcome
}
