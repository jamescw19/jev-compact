import { describe, expect, it } from 'vitest'

import type { StampedHistory } from '../src/ir.js'
import type { JevAsker, JevQuestions, JevResponse, JevState } from '../src/jev/types.js'
import { batchCalls, questionsFor } from '../src/jev/questions.js'
import type { ToolCallObservation } from '../src/rollout/calls.js'
import { DEFAULT_SCORE_OPTIONS, scoreCalls } from '../src/score.js'

function stamped(ordinal: number, item: StampedHistory['item']): StampedHistory {
  return { ordinal, item }
}

function callSequence(count: number): StampedHistory[] {
  const items: StampedHistory[] = [
    stamped(1, { kind: 'message', role: 'user', contents: [{ type: 'input_text', text: 'go' }] }),
  ]
  for (let index = 0; index < count; index += 1) {
    items.push(
      stamped(2 + index * 2, {
        kind: 'function_call',
        callId: `c${index}`,
        name: 'shell',
        argumentsJson: '{}',
      }),
      stamped(3 + index * 2, {
        kind: 'function_call_output',
        callId: `c${index}`,
        outputs: [{ type: 'input_text', text: `out ${index}` }],
      }),
    )
  }
  return items
}

class FakeAsker implements JevAsker {
  readonly asked: { state: JevState; questions: JevQuestions }[] = []
  constructor(private readonly answersFor: (names: string[]) => Record<string, number>) {}

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    this.asked.push({ state, questions })
    const answers: Record<string, { noul: number }> = {}
    for (const name of Object.keys(questions)) {
      const value = this.answersFor(Object.keys(questions))[name]
      if (value !== undefined) answers[name] = { noul: value }
    }
    return { answers }
  }
}

describe('scoreCalls', () => {
  it('keeps calls whose result is still needed', async () => {
    const asker = new FakeAsker(() => ({ call_c0: 0.2, result_c0: 0.9 }))
    const result = await scoreCalls(callSequence(1), asker, { preserveRecentItems: 0 })
    expect(result.decisions[0]).toMatchObject({ action: 'keep', reason: 'scored', pinned: false })
  })

  it('drops only the result when the call still matters', async () => {
    const asker = new FakeAsker(() => ({ call_c0: 0.9, result_c0: 0.2 }))
    const result = await scoreCalls(callSequence(1), asker, { preserveRecentItems: 0 })
    expect(result.decisions[0]?.action).toBe('drop_result')
  })

  it('drops the whole call when neither matters', async () => {
    const asker = new FakeAsker(() => ({ call_c0: 0.1, result_c0: 0.1 }))
    const result = await scoreCalls(callSequence(1), asker, { preserveRecentItems: 0 })
    expect(result.decisions[0]?.action).toBe('drop_call')
  })

  it('pins recent calls without asking', async () => {
    const asker = new FakeAsker(() => ({}))
    const result = await scoreCalls(callSequence(2), asker, { preserveRecentItems: 3 })
    expect(result.asked).toBe(false)
    expect(result.decisions).toHaveLength(2)
    for (const decision of result.decisions) {
      expect(decision).toMatchObject({ action: 'keep', reason: 'pinned', pinned: true })
    }
  })

  it('returns no decisions when there are no tool calls', async () => {
    const asker = new FakeAsker(() => ({}))
    const result = await scoreCalls(
      [stamped(1, { kind: 'message', role: 'user', contents: [{ type: 'input_text', text: 'hi' }] })],
      asker,
    )
    expect(result.asked).toBe(false)
    expect(result.decisions).toEqual([])
  })

  it('degrades to keep when the asker throws', async () => {
    const asker: JevAsker = {
      ask: async () => {
        throw new Error('network down')
      },
    }
    const result = await scoreCalls(callSequence(1), asker, { preserveRecentItems: 0 })
    expect(result.decisions[0]).toMatchObject({ action: 'keep', reason: 'unanswered' })
  })

  it('stops asking once the deadline has passed', async () => {
    const asker = new FakeAsker(() => ({ call_c0: 0.9, result_c0: 0.9 }))
    const result = await scoreCalls(callSequence(3), asker, {
      preserveRecentItems: 0,
      deadlineMs: -1,
      maxRequestTokens: 200,
    })
    expect(result.requests).toBe(0)
    expect(result.decisions.every((decision) => decision.reason === 'unanswered')).toBe(true)
  })

  it('keeps default options stable', () => {
    expect(DEFAULT_SCORE_OPTIONS.keepThreshold).toBe(0.5)
    expect(DEFAULT_SCORE_OPTIONS.preserveRecentItems).toBe(8)
  })
})

describe('batchCalls', () => {
  const calls: ToolCallObservation[] = [0, 1, 2].map((index) => ({
    callId: `c${index}`,
    kind: 'function_call',
    name: 'shell',
    argumentsJson: '{}',
    outputText: 'x',
    outputChars: 1,
    isError: false,
    callOrdinal: index * 2,
    resultOrdinal: index * 2 + 1,
  }))

  it('produces multiple batches under a tight budget', () => {
    expect(batchCalls(calls, 1000, 1150)).toHaveLength(3)
  })

  it('fits everything in one batch with room to spare', () => {
    expect(batchCalls(calls, 100, 30000)).toHaveLength(1)
  })

  it('generates two questions per call', () => {
    const questions = questionsFor(calls[0] as ToolCallObservation)
    expect(Object.keys(questions).sort()).toEqual(['call_c0', 'result_c0'])
  })
})
