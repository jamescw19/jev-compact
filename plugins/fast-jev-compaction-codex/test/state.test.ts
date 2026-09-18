import { describe, expect, it } from 'vitest'

import type { StampedHistory } from '../src/ir.js'
import { buildState, estimateTokens, fitState, goalFromItems, stateTokens } from '../src/jev/state.js'

function stamped(ordinal: number, item: StampedHistory['item']): StampedHistory {
  return { ordinal, item }
}

function bigItems(entryCount: number, textChars: number): StampedHistory[] {
  const items: StampedHistory[] = []
  for (let index = 0; index < entryCount; index += 1) {
    items.push(
      stamped(
        index + 1,
        index % 3 === 0
          ? { kind: 'message', role: 'user', contents: [{ type: 'input_text', text: 'a'.repeat(textChars) }] }
          : index % 3 === 1
            ? {
                kind: 'function_call',
                callId: `call_${index}`,
                name: 'shell',
                argumentsJson: JSON.stringify({ command: 'x'.repeat(textChars) }),
              }
            : {
                kind: 'function_call_output',
                callId: `call_${index}`,
                outputs: [{ type: 'input_text', text: 'r'.repeat(textChars) }],
              },
      ),
    )
  }
  return items
}

describe('estimateTokens', () => {
  it('scales with length and counts CJK heavily', () => {
    const ascii = estimateTokens('abcdefghij')
    const cjk = estimateTokens('十个中文字符看看')
    expect(ascii).toBeGreaterThan(0)
    expect(ascii).toBeLessThan(cjk)
    expect(cjk).toBeGreaterThanOrEqual(8)
  })
})

describe('goalFromItems', () => {
  it('takes the last three user prompts', () => {
    const goal = goalFromItems([
      stamped(1, { kind: 'message', role: 'user', contents: [{ type: 'input_text', text: 'first' }] }),
      stamped(2, { kind: 'message', role: 'assistant', contents: [{ type: 'output_text', text: 'no' }] }),
      stamped(3, { kind: 'message', role: 'user', contents: [{ type: 'input_text', text: 'second' }] }),
      stamped(4, { kind: 'message', role: 'user', contents: [{ type: 'input_text', text: 'third' }] }),
    ])
    expect(goal).toBe('first\n---\nsecond\n---\nthird')
  })
})

describe('buildState', () => {
  it('maps items to entries and skips reasoning', () => {
    const state = buildState([
      stamped(1, { kind: 'message', role: 'user', contents: [{ type: 'input_text', text: 'run it' }] }),
      stamped(2, { kind: 'function_call', callId: 'c1', name: 'shell', argumentsJson: '{"command":"ls"}' }),
      stamped(3, { kind: 'function_call_output', callId: 'c1', outputs: [{ type: 'input_text', text: 'out' }] }),
      stamped(4, { kind: 'reasoning', id: 'rs_1' }),
    ])
    expect(state.history).toHaveLength(3)
    expect(state.history[1]?.call).toEqual({ id: 'c1', name: 'shell', input: '{"command":"ls"}' })
    expect(state.history[2]?.result).toEqual({ id: 'c1', chars: 3 })
  })
})

describe('fitState', () => {
  it('returns the full state when under budget', () => {
    const fitted = fitState(bigItems(6, 50), { maxStateTokens: 100000, preserveRecentItems: 2 })
    expect(fitted.stage).toBe('full')
  })

  it('degrades through stages and pins recent items', () => {
    const items = bigItems(30, 2000)
    const fitted = fitState(items, { maxStateTokens: 800, preserveRecentItems: 2 })
    expect(fitted.stage).not.toBe('full')
    const pinnedTexts = fitted.state.history.filter((entry) => entry.i >= items.length - 1)
    for (const entry of pinnedTexts) {
      if (entry.call !== undefined) expect(entry.call.input.length).toBeGreaterThan(60)
    }
  })

  it('never throws even under an absurd budget', () => {
    const fitted = fitState(bigItems(20, 5000), { maxStateTokens: 1, preserveRecentItems: 1 })
    expect(stateTokens(fitted.state)).toBeGreaterThan(0)
    expect(['old-dropped', 'over-budget']).toContain(fitted.stage)
  })
})
