import { findLatestArchive, markConsumed } from '../archive.js'
import { buildAdditionalContext, collectCandidates, rankAndFit } from '../backfill.js'
import { resolveDataDir } from '../config.js'
import type { FastJevConfig } from '../config.js'
import { effectiveHistory, parseTranscriptFile } from '../rollout/index.js'
import type { HookOutcome } from './outcome.js'

export interface SessionStartInput {
  readonly sessionId: string
  readonly source: string
  readonly transcriptPath: string
}

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
  const transcriptPath = record['transcript_path']
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return null
  return {
    sessionId: typeof record['session_id'] === 'string' ? record['session_id'] : 'unknown',
    source: typeof record['source'] === 'string' ? record['source'] : 'unknown',
    transcriptPath,
  }
}

/**
 * SessionStart(source=compact) hook body: find the archive the PreCompact
 * hook wrote, check which scored-critical outputs the built-in summary
 * actually lost, and re-inject them verbatim via `additionalContext`.
 * Anything other than a compaction start is a no-op.
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
    input.transcriptPath,
    config.archiveTtlHours,
  )
  if (hit === null) {
    return { note: 'fast-jev: no fresh archive for this compaction' }
  }
  const { transcript } = await parseTranscriptFile(input.transcriptPath)
  const history = effectiveHistory(transcript)

  const candidates = collectCandidates(hit.archive, history, 300)
  await markConsumed(hit.path)
  if (candidates.length === 0) {
    return { note: 'fast-jev: archive processed; the summary kept everything that mattered' }
  }
  const fitted = rankAndFit(candidates, config.maxBackfillChars, config.perItemChars)
  if (fitted.length === 0) {
    return { note: 'fast-jev: backfill candidates exceeded the character budget' }
  }
  return {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: buildAdditionalContext(fitted, candidates.length),
    },
  }
}
