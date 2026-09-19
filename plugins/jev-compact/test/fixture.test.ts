import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { liveItems } from '../src/ir.js'
import { pairToolCalls } from '../src/rollout/calls.js'
import { parseTranscriptFile } from '../src/rollout/parse.js'

const FIXTURE = 'test/fixtures/rollout-compacted-sample.jsonl'

describe.skipIf(!existsSync(FIXTURE))('real rollout fixture', () => {
  it('parses and finds the compaction boundary', async () => {
    const { transcript, stats } = await parseTranscriptFile(FIXTURE)
    expect(transcript.lastCompacted).toBeDefined()
    expect(stats.compactions).toBeGreaterThanOrEqual(1)
    expect(stats.lines).toBeGreaterThan(40)
    expect(stats.parsedItems).toBeGreaterThan(10)
  })

  it('pairs tool calls on both sides of the compaction', async () => {
    const { transcript } = await parseTranscriptFile(FIXTURE)
    const effective = [...transcript.segments.flatMap((segment) => segment.items)]
    const calls = pairToolCalls(effective)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.callId).not.toBe('')
      expect(call.outputChars).toBeGreaterThan(0)
    }
    expect(liveItems(transcript).length).toBeGreaterThanOrEqual(0)
  })
})
