import { createHash } from 'node:crypto'

import { itemText } from './ir.js'
import type { StampedHistory } from './ir.js'
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

function callIdInHistory(item: ArchivedCallItem, history: readonly StampedHistory[]): boolean {
  return history.some(({ item: candidate }) => {
    if (candidate.kind !== 'function_call' && candidate.kind !== 'custom_tool_call') return false
    return candidate.callId === item.callId
  })
}

function textInHistory(needle: string, texts: readonly string[]): boolean {
  if (needle === '') return true
  const head = needle.slice(0, FINGERPRINT_HEAD)
  const hashes = new Set(texts.map(fingerprint))
  if (hashes.has(fingerprint(needle))) return true
  if (needle.length >= FINGERPRINT_HEAD) {
    return texts.some((text) => text.includes(head))
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
  if (callIdInHistory(item, history)) return 'present_by_call_id'
  const texts = history.map(({ item: candidate }) => itemText(candidate))
  return textInHistory(item.outputText, texts) ? 'present_by_fingerprint' : 'missing'
}

function headTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars === 0) return ''
  const head = Math.floor(maxChars * 0.7)
  const tail = maxChars - head
  return `${text.slice(0, head)}…[${text.length - maxChars} chars omitted]${text.slice(text.length - tail)}`
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
  const candidates: BackfillCandidate[] = []
  for (const item of archive.items) {
    if (item.action === 'drop_call') continue
    if (membership(item, history) !== 'missing') continue
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
  const lines: string[] = [
    `<fast-jev-compaction: the built-in summary lost ${droppedCount} tool result(s) that were scored ` +
      'as still required. Verbatim content follows; treat it as part of the earlier conversation.>',
  ]
  candidates.forEach((candidate, index) => {
    const { item } = candidate
    const label = `[${index + 1}] tool ${item.name} (call ${item.callId}, score ${candidate.score.toFixed(2)})`
    if (candidate.reason === 'call_note') {
      lines.push(`${label}`, `    input: ${candidate.content}`, '    output was dropped intentionally; re-run the tool if needed')
      return
    }
    lines.push(`${label}`, `    output:`, ...candidate.content.split('\n').map((line) => `    ${line}`))
  })
  lines.push('</fast-jev-compaction>')
  return lines.join('\n')
}
