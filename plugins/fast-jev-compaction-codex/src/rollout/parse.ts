import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

import type { StampedHistory, Transcript, TranscriptSegment } from '../ir.js'
import { narrowItem } from './items.js'

export interface ParseStats {
  readonly lines: number
  readonly parsedItems: number
  readonly skippedLines: number
  readonly compactions: number
}

export interface ParseResult {
  readonly transcript: Transcript
  readonly stats: ParseStats
}

interface BuilderState {
  meta: Transcript['meta']
  segments: TranscriptSegment[]
  current: StampedHistory[]
  currentStart: number
  currentIsLive: boolean
  lastCompacted: Transcript['lastCompacted']
  lines: number
  parsedItems: number
  skippedLines: number
  compactions: number
}


function initialState(): BuilderState {
  return {
    meta: {},
    segments: [],
    current: [],
    currentStart: 1,
    currentIsLive: true,
    lastCompacted: undefined,
    lines: 0,
    parsedItems: 0,
    skippedLines: 0,
    compactions: 0,
  }
}

const IGNORED_LINE_TYPES = new Set([
  'event_msg',
  'token_usage_record',
  'turn_context',
  'world_state',
])

/**
 * Parse a rollout JSONL string into a `Transcript`. Never throws on malformed
 * lines: they are counted in `stats.skippedLines` and skipped. A `compacted`
 * record closes the current segment and opens a new one seeded with its
 * `replacement_history` (marked as a survivor prefix).
 */
export function parseTranscript(jsonl: string): ParseResult {
  const state = initialState()
  const lines = jsonl.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  for (const line of lines) consumeLine(state, line)
  closeSegment(state)
  return { transcript: finalize(state), stats: statsOf(state) }
}

/** Stream-parse a rollout file (rollouts can grow to hundreds of MB). */
export async function parseTranscriptFile(path: string): Promise<ParseResult> {
  const state = initialState()
  const reader = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of reader) consumeLine(state, line)
  closeSegment(state)
  return { transcript: finalize(state), stats: statsOf(state) }
}

function consumeLine(state: BuilderState, line: string): void {
  state.lines += 1
  if (line.trim() === '') return
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    state.skippedLines += 1
    return
  }
  if (typeof parsed !== 'object' || parsed === null) {
    state.skippedLines += 1
    return
  }
  const record = parsed as { type?: unknown; payload?: unknown }
  if (record['type'] === 'session_meta') {
    state.meta = readMeta(record['payload'])
    return
  }
  if (IGNORED_LINE_TYPES.has(String(record['type']))) return
  if (record['type'] === 'compacted') {
    consumeCompacted(state, state.lines, record['payload'])
    return
  }
  if (record['type'] !== 'response_item') {
    state.skippedLines += 1
    return
  }
  appendItem(state, state.lines, narrowItem(record['payload']))
}

function consumeCompacted(state: BuilderState, ordinal: number, payload: unknown): void {
  state.compactions += 1
  closeSegment(state)
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    message?: unknown
    window_id?: unknown
    replacement_history?: unknown
  }
  state.lastCompacted = {
    ordinal,
    windowId: typeof record['window_id'] === 'string' ? record['window_id'] : undefined,
    message: typeof record['message'] === 'string' ? record['message'] : '',
  }
  state.currentStart = ordinal
  state.currentIsLive = false
  const history = Array.isArray(record['replacement_history']) ? record['replacement_history'] : []
  for (const entry of history) appendItem(state, ordinal, narrowItem(entry))
}

function appendItem(state: BuilderState, ordinal: number, item: ReturnType<typeof narrowItem>): void {
  if (state.current.length === 0) state.currentStart = ordinal
  // Local builder buffer — frozen (copied once) when the segment closes, so
  // parsing stays linear even for rollouts with hundreds of thousands of items.
  state.current.push({ ordinal, item })
  state.parsedItems += 1
}

function closeSegment(state: BuilderState): void {
  if (state.current.length === 0) return
  state.segments = [
    ...state.segments,
    {
      items: [...state.current],
      firstOrdinal: state.currentStart,
      survivorPrefix: !state.currentIsLive,
    },
  ]
  state.current = []
  state.currentIsLive = true
}

function readMeta(payload: unknown): Transcript['meta'] {
  if (typeof payload !== 'object' || payload === null) return {}
  const record = payload as { id?: unknown; session_id?: unknown; cwd?: unknown }
  return {
    sessionId:
      typeof record['session_id'] === 'string'
        ? record['session_id']
        : typeof record['id'] === 'string'
          ? record['id']
          : undefined,
    cwd: typeof record['cwd'] === 'string' ? record['cwd'] : undefined,
  }
}

function statsOf(state: BuilderState): ParseStats {
  return {
    lines: state.lines,
    parsedItems: state.parsedItems,
    skippedLines: state.skippedLines,
    compactions: state.compactions,
  }
}

function finalize(state: BuilderState): Transcript {
  return {
    meta: state.meta,
    segments: state.segments,
    lastCompacted: state.lastCompacted,
  }
}
