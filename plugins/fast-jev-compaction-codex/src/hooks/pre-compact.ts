import { stat } from 'node:fs/promises'

import { writeArchive, cleanupExpired } from '../archive.js'
import type { DecisionArchive, ArchivedCallItem } from '../archive.js'
import type { HookOutcome } from './outcome.js'
import { resolveDataDir } from '../config.js'
import type { FastJevConfig } from '../config.js'
import { liveItems, parseTranscriptFile } from '../rollout/index.js'
import { appendLog } from '../log.js'
import { JevClient } from '../jev/client.js'
import type { JevAsker } from '../jev/types.js'
import { scoreCalls } from '../score.js'

export interface PreCompactInput {
  readonly sessionId: string
  readonly turnId?: string
  readonly trigger: 'manual' | 'auto'
  readonly transcriptPath: string
}

function decodeTrigger(value: unknown): 'manual' | 'auto' {
  return value === 'auto' ? 'auto' : 'manual'
}

/** Parse the PreCompact hook stdin payload, tolerating missing fields. */
export function parsePreCompactInput(raw: string): PreCompactInput | null {
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
    turnId: typeof record['turn_id'] === 'string' ? record['turn_id'] : undefined,
    trigger: decodeTrigger(record['trigger']),
    transcriptPath,
  }
}

/**
 * PreCompact hook body: score the live segment, archive the decisions, and
 * always let the built-in compaction proceed. Any failure degrades to a
 * silent no-op so the hook never blocks or cancels a compaction.
 */
export async function runPreCompact(
  input: PreCompactInput,
  config: FastJevConfig,
  env: NodeJS.ProcessEnv = process.env,
  asker?: JevAsker,
): Promise<HookOutcome> {
  const { transcript, stats } = await parseTranscriptFile(input.transcriptPath)
  const items = liveItems(transcript)
  const transport =
    asker ??
    (config.apiKey === null
      ? null
      : new JevClient({
          apiKey: config.apiKey,
          model: config.model,
          baseUrl: config.baseUrl ?? undefined,
          timeoutMs: config.jevRequestTimeoutMs,
        }))
  if (transport === null) {
    return {
      continue: true,
      note: 'fast-jev: TYPESAFE_API_KEY not configured; letting built-in compaction proceed',
    }
  }
  if (items.length === 0) {
    return { continue: true, note: 'fast-jev: nothing new to score' }
  }

  const bytesAtScore = await stat(input.transcriptPath)
    .then((info) => info.size)
    .catch(() => 0)
  const scored = await scoreCalls(items, transport, {
    keepThreshold: config.keepThreshold,
    preserveRecentItems: config.preserveRecentItems,
    maxStateTokens: config.maxStateTokens,
    maxRequestTokens: config.maxRequestTokens,
    deadlineMs: config.jevDeadlineMs,
  })

  const archivedItems: ArchivedCallItem[] = scored.decisions.map((decision) => ({
    callId: decision.call.callId,
    kind: decision.call.kind,
    name: decision.call.name,
    argumentsJson: decision.call.argumentsJson,
    outputText: decision.call.outputText,
    outputChars: decision.call.outputChars,
    isError: decision.call.isError,
    callOrdinal: decision.call.callOrdinal,
    resultOrdinal: decision.call.resultOrdinal,
    keepCall: decision.keepCall,
    keepResult: decision.keepResult,
    action: decision.action,
    pinned: decision.pinned,
  }))
  const archive: DecisionArchive = {
    version: 1,
    sessionId: input.sessionId,
    turnId: input.turnId,
    trigger: input.trigger,
    transcriptPath: input.transcriptPath,
    transcriptBytesAtScore: bytesAtScore,
    scoredAt: new Date().toISOString(),
    model: config.model,
    stateStage: scored.stateStage,
    config: { keepThreshold: config.keepThreshold, preserveRecentItems: config.preserveRecentItems },
    items: archivedItems,
  }
  const dataDir = resolveDataDir(config, env)
  void appendLog(dataDir, {
    event: 'pre-compact', phase: 'scored', trigger: input.trigger,
    calls: archive.items.length, stateStage: scored.stateStage,
    failedBatches: scored.failedBatches, liveItems: items.length,
    dataDirBasis: 'PLUGIN_DATA' in env ? 'plugin-data' : 'codex-home',
  })
  const archivePath = await writeArchive(dataDir, archive)
  void cleanupExpired(dataDir, config.archiveTtlHours).catch(() => undefined)

  const keeps = archive.items.filter((item) => item.action === 'keep').length
  const resultDrops = archive.items.filter((item) => item.action === 'drop_result').length
  const callDrops = archive.items.filter((item) => item.action === 'drop_call').length
  void archivePath
  const failedNote = scored.failedBatches > 0 ? `; ${scored.failedBatches} batch(es) unanswered` : ''
  return {
    continue: true,
    systemMessage:
      `fast-jev: scored ${archive.items.length} tool calls ` +
      `(${keeps} keep / ${resultDrops} result-drop / ${callDrops} call-drop) over ${items.length} live items` +
      failedNote,
  }
}
