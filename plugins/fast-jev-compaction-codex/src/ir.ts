/**
 * Intermediate representation for Codex rollout transcripts.
 *
 * The IR mirrors Codex's native `response_item` payloads instead of
 * upstream fast-jev-compaction's Claude Code `Message` shape: every
 * variant keeps its `call_id` so pairing and membership checks stay
 * exact, and every stamped item carries the rollout line ordinal it
 * came from so archives can reference original positions.
 */

export interface ContentPart {
  readonly type: string
  readonly text: string
}

export type MessageRole = 'user' | 'assistant' | 'developer'

export type HistoryItem =
  | {
      readonly kind: 'message'
      readonly role: MessageRole
      readonly contents: readonly ContentPart[]
    }
  | {
      readonly kind: 'function_call'
      readonly callId: string
      readonly name: string
      readonly argumentsJson: string
    }
  | {
      readonly kind: 'function_call_output'
      readonly callId: string
      readonly outputs: readonly ContentPart[]
    }
  | {
      readonly kind: 'custom_tool_call'
      readonly callId: string
      readonly name: string
      readonly input: string
      readonly status?: string
    }
  | {
      readonly kind: 'custom_tool_call_output'
      readonly callId: string
      readonly outputs: readonly ContentPart[]
    }
  | { readonly kind: 'reasoning'; readonly id?: string }
  | { readonly kind: 'other'; readonly payloadType: string; readonly text: string }

/** A history item stamped with the 1-based rollout line it came from. */
export interface StampedHistory {
  readonly ordinal: number
  readonly item: HistoryItem
}

export interface TranscriptSegment {
  readonly items: readonly StampedHistory[]
  /** Rollout line ordinal of the first item in this segment. */
  readonly firstOrdinal: number
  /**
   * True when the segment starts from a `compacted` record's
   * `replacement_history` (i.e. it is a built-in-summary survivor prefix).
   */
  readonly survivorPrefix: boolean
}

export interface CompactionRecord {
  readonly ordinal: number
  readonly windowId?: string
  readonly message: string
}

export interface Transcript {
  readonly meta: { readonly sessionId?: string; readonly cwd?: string }
  readonly segments: readonly TranscriptSegment[]
  readonly lastCompacted?: CompactionRecord
}

/**
 * The history Codex will actually send to the model: the survivor prefix of
 * the last compaction plus everything recorded after it.
 */
export function effectiveHistory(transcript: Transcript): readonly StampedHistory[] {
  const last = transcript.segments[transcript.segments.length - 1]
  return last === undefined ? [] : last.items
}

/**
 * The items produced *after* the last compaction — the scoring candidates.
 * Post-compaction items share a segment with the survivor prefix; they are
 * the ones stamped with an ordinal later than the `compacted` record itself.
 */
export function liveItems(transcript: Transcript): readonly StampedHistory[] {
  const last = transcript.segments[transcript.segments.length - 1]
  if (last === undefined) return []
  const compactedAt = transcript.lastCompacted?.ordinal ?? Number.NEGATIVE_INFINITY
  return last.items.filter((stamped) => stamped.ordinal > compactedAt)
}

/**
 * Ordinals of the most recent `count` items (by list position, not by
 * rollout line number — rollout files interleave non-history event lines).
 */
export function recentOrdinals(items: readonly StampedHistory[], count: number): Set<number> {
  const pinned = new Set<number>()
  for (let index = Math.max(0, items.length - count); index < items.length; index += 1) {
    const ordinal = items[index]?.ordinal
    if (ordinal !== undefined) pinned.add(ordinal)
  }
  return pinned
}

/** Concatenated text of an item — used for Jev state and fingerprints alike. */
export function itemText(item: HistoryItem): string {
  switch (item.kind) {
    case 'message':
      return item.contents.map((part) => part.text).join('\n')
    case 'function_call':
      return `${item.name} ${item.argumentsJson}`
    case 'function_call_output':
    case 'custom_tool_call_output':
      return item.outputs
        .map((part) => part.text)
        .filter((text) => text !== '')
        .join('\n')
    case 'custom_tool_call':
      return item.input
    case 'reasoning':
      return ''
    case 'other':
      return item.text
  }
}
