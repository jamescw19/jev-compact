import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { effectiveHistory, liveItems } from '../src/ir.js'
import { parseTranscript, parseTranscriptFile } from '../src/rollout/parse.js'

const metaLine = JSON.stringify({
  timestamp: '2026-09-18T08:00:00Z',
  ordinal: 0,
  type: 'session_meta',
  payload: { session_id: 'sess-1', cwd: '/tmp/proj' },
})

function responseItem(type: string, extra: Record<string, unknown>, ordinal: number): string {
  return JSON.stringify({ timestamp: 't', ordinal, type: 'response_item', payload: { type, ...extra } })
}

function eventLine(type: string, ordinal: number): string {
  return JSON.stringify({ timestamp: 't', ordinal, type: 'event_msg', payload: { type } })
}

const compactedLine = JSON.stringify({
  timestamp: 't',
  ordinal: 10,
  type: 'compacted',
  payload: {
    message: 'summary',
    window_id: 'w2',
    replacement_history: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'earlier ask' }] },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA' },
    ],
  },
})

const SAMPLE = [
  metaLine,
  responseItem('message', { role: 'user', content: [{ type: 'input_text', text: 'hello' }] }, 1),
  responseItem(
    'function_call',
    { call_id: 'call_a', name: 'shell', arguments: '{"command":"ls"}' },
    2,
  ),
  responseItem(
    'function_call_output',
    { call_id: 'call_a', output: [{ type: 'input_text', text: 'file.txt' }] },
    3,
  ),
  eventLine('token_count', 4),
  'this is not json',
  responseItem(
    'custom_tool_call',
    { call_id: 'call_b', name: 'exec', status: 'completed', input: 'text(1)' },
    6,
  ),
  responseItem(
    'custom_tool_call_output',
    { call_id: 'call_b', output: [{ type: 'input_text', text: 'done' }] },
    7,
  ),
  responseItem('reasoning', { id: 'rs_0' }, 8),
  compactedLine,
  responseItem('message', { role: 'assistant', content: [{ type: 'output_text', text: 'after' }] }, 10),
  JSON.stringify({ timestamp: 't', ordinal: 11, type: 'token_usage_record', payload: {} }),
].join('\n')

describe('parseTranscript', () => {
  const parsed = parseTranscript(SAMPLE)

  it('reads session meta', () => {
    expect(parsed.transcript.meta).toEqual({ sessionId: 'sess-1', cwd: '/tmp/proj' })
  })

  it('counts lines and skips malformed ones', () => {
    expect(parsed.stats.lines).toBe(12)
    expect(parsed.stats.skippedLines).toBe(1)
    expect(parsed.stats.compactions).toBe(1)
  })

  it('splits segments at the compacted record', () => {
    const { segments } = parsed.transcript
    expect(segments).toHaveLength(2)
    expect(segments[0]?.survivorPrefix).toBe(false)
    expect(segments[1]?.survivorPrefix).toBe(true)
    expect(segments[1]?.firstOrdinal).toBe(10)
  })

  it('stamps items with rollout ordinals, including replacement history', () => {
    const [, second] = parsed.transcript.segments
    expect(second?.items.map((stamped) => stamped.ordinal)).toEqual([10, 10, 11])
  })

  it('records the compaction record', () => {
    expect(parsed.transcript.lastCompacted).toEqual({
      ordinal: 10,
      windowId: 'w2',
      message: 'summary',
    })
  })

  it('exposes survivor+live history as effective history', () => {
    const kinds = effectiveHistory(parsed.transcript).map((stamped) => stamped.item.kind)
    expect(kinds).toEqual(['message', 'reasoning', 'message'])
  })

  it('limits live items to those after the compaction', () => {
    const kinds = liveItems(parsed.transcript).map((stamped) => stamped.item.kind)
    expect(kinds).toEqual(['message'])
  })

  it('handles a transcript without compaction', () => {
    const simple = parseTranscript([metaLine, responseItem('message', { role: 'user', content: 'x' }, 1)].join('\n'))
    expect(simple.transcript.segments).toHaveLength(1)
    expect(simple.transcript.lastCompacted).toBeUndefined()
    expect(liveItems(simple.transcript)).toHaveLength(1)
  })

  it('returns an empty transcript for empty input', () => {
    const empty = parseTranscript('')
    expect(empty.transcript.segments).toEqual([])
    expect(empty.stats.lines).toBe(0)
  })
})

describe('parseTranscriptFile', () => {
  it('parses the same content from disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'jev-parse-'))
    const file = path.join(dir, 'rollout.jsonl')
    await writeFile(file, SAMPLE + '\n', 'utf8')
    const fromFile = await parseTranscriptFile(file)
    const fromString = parseTranscript(SAMPLE)
    expect(fromFile.stats).toEqual(fromString.stats)
    expect(fromFile.transcript).toEqual(fromString.transcript)
    await readFile(file, 'utf8')
  })
})
