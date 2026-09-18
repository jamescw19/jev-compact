import { createHash } from 'node:crypto'

import { itemText } from './ir.js'
import type { StampedHistory } from './ir.js'
import { headTail } from './text.js'
import type { ArchivedCallItem, DecisionArchive } from './archive.js'

export type Membership = 'present_by_call_id' | 'present_by_fingerprint' | 'missing'

export interface BackfillCandidate {
  readonly item: ArchivedCallItem
  readonly reason: 'verbatim_missing' | 'call_note'
  readonly content: string
  readonly score: number
}

const FINGERPRINT_HEAD = 200

/** Stable content fingerprint for verbatim-presence checks. */
export function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Texts plus their hashes, computed once per compaction instead of once per item. */
export interface HistoryIndex {
  readonly callIds: ReadonlySet<string>
  readonly texts: readonly string[]
  readonly hashes: ReadonlySet<string>
}

export function indexHistory(history: readonly StampedHistory[]): HistoryIndex {
  const callIds = new Set<string>()
  for (const { item } of history) {
    if (item.kind === 'function_call' || item.kind === 'custom_tool_call') callIds.add(item.callId)
  }
  const texts = history.map(({ item }) => itemText(item))
  return { callIds, texts, hashes: new Set(texts.map(fingerprint)) }
}

function textInHistory(needle: string, index: HistoryIndex): boolean {
  if (needle === '') return true
  if (index.hashes.has(fingerprint(needle))) return true
  if (needle.length >= FINGERPRINT_HEAD) {
    const head = needle.slice(0, FINGERPRINT_HEAD)
    return index.texts.some((text) => text.includes(head))
  }
  return false
}

/**
 * Decide whether an archived call's content survived the built-in summary:
 * exact `call_id` presence first, then verbatim fingerprint (full hash, then
 * head-substring search for summaries that only quote part of the output).
 * Ambiguity resolves to `missing` — re-injecting is harmless, losing content
 * is not.
 */
export function membership(item: ArchivedCallItem, history: readonly StampedHistory[]): Membership {
  return membershipIn(item, indexHistory(history))
}

export function membershipIn(item: ArchivedCallItem, index: HistoryIndex): Membership {
  if (index.callIds.has(item.callId)) return 'present_by_call_id'
  return textInHistory(item.outputText, index) ? 'present_by_fingerprint' : 'missing'
}

/**
 * Collect backfill candidates from an archive: `keep` items whose output the
 * summary lost (verbatim restoration), and `drop_result` items as short
 * call notes. `drop_call` items were judged droppable and never come back.
 */
export function collectCandidates(
  archive: DecisionArchive,
  history: readonly StampedHistory[],
  noteChars: number,
): BackfillCandidate[] {
  const index = indexHistory(history)
  const candidates: BackfillCandidate[] = []
  for (const item of archive.items) {
    if (item.action === 'drop_call') continue
    if (membershipIn(item, index) !== 'missing') continue
    if (item.action === 'keep') {
      candidates.push({
        item,
        reason: 'verbatim_missing',
        content: item.outputText,
        score: Math.max(item.keepResult, item.keepCall),
      })
    } else {
      const input = item.argumentsJson.slice(0, Math.max(0, noteChars))
      candidates.push({
        item,
        reason: 'call_note',
        content: input,
        score: item.keepCall,
      })
    }
  }
  return candidates
}

/**
 * Rank candidates by score (then by cheapest-to-restore) and greedily fit
 * them into the character budget, trimming each item's content with a
 * head+tail window.
 */
export function rankAndFit(
  candidates: readonly BackfillCandidate[],
  maxTotalChars: number,
  perItemChars: number,
): BackfillCandidate[] {
  const ranked = [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.reason !== b.reason) return a.reason === 'call_note' ? -1 : 1
    return a.content.length - b.content.length
  })
  const fitted: BackfillCandidate[] = []
  let used = 0
  for (const candidate of ranked) {
    const content = headTail(candidate.content, perItemChars)
    if (used + content.length > maxTotalChars) continue
    fitted.push({ ...candidate, content })
    used += content.length
  }
  return fitted
}

/** Render the fitted candidates as an additionalContext block. */
export function buildAdditionalContext(
  candidates: readonly BackfillCandidate[],
  droppedCount: number,
): string {
  const shown = candidates.length
  const intro =
    `<fast-jev-compaction: the built-in summary lost ${droppedCount} tool result(s) that were scored ` +
    `as still required; showing ${shown}. Verbatim content follows; treat it as part of the earlier conversation.>`
  const lines: string[] = [intro]
  candidates.forEach((candidate, index) => {
    const { item } = candidate
    const label = `[${index + 1}] tool ${item.name} (call ${item.callId}, score ${candidate.score.toFixed(2)})`
    if (candidate.reason === 'call_note') {
      lines.push(
        label,
        `    input: ${candidate.content}`,
        '    output was dropped intentionally; re-run the tool if needed',
      )
      return
    }
    lines.push(label, '    output:', ...candidate.content.split('\n').map((line) => `    ${line}`))
  })
  lines.push('</fast-jev-compaction>')
  return lines.join('\n')
}
