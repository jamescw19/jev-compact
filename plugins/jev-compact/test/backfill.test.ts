import { describe, expect, it } from 'vitest'

import { buildAdditionalContext, collectCandidates, membership, rankAndFit } from '../src/backfill.js'
import type { StampedHistory } from '../src/ir.js'
import type { ArchivedCallItem } from '../src/archive.js'

function stamped(ordinal: number, item: StampedHistory['item']): StampedHistory {
  return { ordinal, item }
}

function archived(overrides: Partial<ArchivedCallItem> = {}): ArchivedCallItem {
  return {
    callId: 'call_a',
    kind: 'function_call',
    name: 'shell',
    argumentsJson: '{"command":"cargo test"}',
    outputText: '127 test results passed',
    outputChars: 24,
    isError: false,
    callOrdinal: 2,
    resultOrdinal: 3,
    keepCall: 0.9,
    keepResult: 0.9,
    action: 'keep',
    pinned: false,
    ...overrides,
  }
}

describe('membership', () => {
  const item = archived()

  it('detects presence by call_id', () => {
    const history = [stamped(5, { kind: 'function_call', callId: 'call_a', name: 'shell', argumentsJson: '{}' })]
    expect(membership(item, history)).toBe('present_by_call_id')
  })

  it('detects verbatim presence by full fingerprint', () => {
    const asMessage: StampedHistory = {
      ordinal: 5,
      item: { kind: 'other', payloadType: 'output', text: '127 test results passed' },
    }
    expect(membership(item, [asMessage])).toBe('present_by_fingerprint')
  })

  it('detects partial presence via head-substring search', () => {
    const longOutput = 'x'.repeat(300)
    const item2 = archived({ outputText: longOutput, outputChars: 300 })
    const asMessage: StampedHistory = {
      ordinal: 5,
      item: { kind: 'other', payloadType: 'output', text: `prefix ${'x'.repeat(250)} suffix` },
    }
    expect(membership(item2, [asMessage])).toBe('present_by_fingerprint')
  })

  it('reports missing when nothing matches', () => {
    const asMessage: StampedHistory = {
      ordinal: 5,
      item: { kind: 'other', payloadType: 'output', text: 'totally different' },
    }
    expect(membership(item, [asMessage])).toBe('missing')
    expect(membership(item, [])).toBe('missing')
  })
})

describe('collectCandidates', () => {
  it('collects missing keeps and drop_result notes, skips drop_call and present items', () => {
    const archive = {
      version: 1 as const,
      sessionId: 's',
      trigger: 'manual' as const,
      transcriptPath: '/t.jsonl',
      transcriptBytesAtScore: 1,
      scoredAt: new Date().toISOString(),
      model: 'm',
      stateStage: 'full',
      config: { keepThreshold: 0.5, preserveRecentItems: 8 },
      items: [
        archived(),
        archived({ callId: 'call_b', action: 'drop_result' as const, keepCall: 0.8, keepResult: 0.1 }),
        archived({ callId: 'call_c', action: 'drop_call' as const }),
        archived({ callId: 'call_present', outputText: 'kept verbatim' }),
      ],
    }
    const historyWithPresent: StampedHistory[] = [
      stamped(9, { kind: 'other', payloadType: 'output', text: 'kept verbatim' }),
    ]
    const candidates = collectCandidates(archive, historyWithPresent, 300)
    expect(candidates.map((candidate) => candidate.item.callId).sort()).toEqual(['call_a', 'call_b'])
    expect(candidates.find((candidate) => candidate.item.callId === 'call_b')?.reason).toBe('call_note')
    expect(candidates.find((candidate) => candidate.item.callId === 'call_a')?.reason).toBe('verbatim_missing')
  })
})

describe('rankAndFit', () => {
  const candidates = [
    { item: archived({ callId: 'low' }), reason: 'verbatim_missing' as const, content: 'a'.repeat(100), score: 0.6 },
    { item: archived({ callId: 'high' }), reason: 'verbatim_missing' as const, content: 'b'.repeat(100), score: 0.95 },
    { item: archived({ callId: 'mid' }), reason: 'verbatim_missing' as const, content: 'c'.repeat(100), score: 0.75 },
  ]

  it('ranks by score and respects the total budget', () => {
    const fitted = rankAndFit(candidates, 250, 4000)
    expect(fitted.map((candidate) => candidate.item.callId)).toEqual(['high', 'mid'])
  })

  it('trims per-item content with a head+tail window', () => {
    const fitted = rankAndFit(candidates, 8000, 40)
    expect(fitted[0]?.content).toContain('chars omitted')
    expect(fitted[0]?.content.length).toBeLessThanOrEqual(60)
  })
})

describe('buildAdditionalContext', () => {
  it('wraps candidates with markers and per-item labels', () => {
    const fitted = rankAndFit(
      [
        { item: archived(), reason: 'verbatim_missing' as const, content: '127 test results passed', score: 0.9 },
        {
          item: archived({ callId: 'call_b', action: 'drop_result' as const }),
          reason: 'call_note' as const,
          content: '{"command":"cargo test"}',
          score: 0.8,
        },
      ],
      8000,
      4000,
    )
    const text = buildAdditionalContext(fitted, 2)
    expect(text).toContain('<fast-jev-compaction:')
    expect(text).toContain('lost 2 tool result(s)')
    expect(text).toContain('[1] tool shell (call call_a, score 0.90)')
    expect(text).toContain('    output:')
    expect(text).toContain('    127 test results passed')
    expect(text).toContain('re-run the tool if needed')
    expect(text.trim().endsWith('</fast-jev-compaction>')).toBe(true)
  })
})
