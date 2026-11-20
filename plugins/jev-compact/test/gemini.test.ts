import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { configPath, DEFAULT_CONFIG, loadConfig } from '../src/config.js'
import { JevClient } from '../src/jev/client.js'
import { batchCalls, questionsFor } from '../src/jev/questions.js'
import { buildJevRequest, noulAnswer, parseJevResponse } from '../src/jev/request.js'
import type { ToolCallObservation } from '../src/rollout/calls.js'
import { scoreCalls } from '../src/score.js'

const state = { context: 'coding session', goal: 'fix bug', history: [] }
const call: ToolCallObservation = {
  callId: 'call_1', kind: 'function_call', name: 'shell', argumentsJson: '{}',
  outputText: 'test results', outputChars: 12, isError: false, callOrdinal: 1, resultOrdinal: 2,
}

describe('Gemini Decisions API', () => {
  it('sends serialized context as input with native noul criteria and API-key auth', () => {
    const questions = questionsFor(call)
    const request = buildJevRequest({ apiKey: 'test-key' }, state, questions)
    expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/decisions')
    expect(request.headers['x-goog-api-key']).toBe('test-key')
    expect(request.headers).not.toHaveProperty('authorization')
    expect(JSON.parse(request.body)).toEqual({
      model: 'gemini-decision-1', input: JSON.stringify(state), questions,
    })
    expect(questions['call_call_1']?.criteria).toEqual({
      true_description: 'still matters', false_description: 'droppable together with its output',
    })
  })

  it('uses GEMINI_API_KEY before the config key and ignores TYPESAFE_API_KEY', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'gemini-config-'))
    try {
      await writeFile(configPath({ CODEX_HOME: home }), JSON.stringify({ apiKey: 'file-key' }))
      const config = await loadConfig({ CODEX_HOME: home, GEMINI_API_KEY: ' gemini-key ', TYPESAFE_API_KEY: 'old-key' })
      expect(config.apiKey).toBe('gemini-key')
      expect(config.model).toBe('gemini-decision-1')
      expect((await loadConfig({ CODEX_HOME: home, TYPESAFE_API_KEY: 'old-key' })).apiKey).toBe('file-key')
      await rm(configPath({ CODEX_HOME: home }))
      expect((await loadConfig({ CODEX_HOME: home, TYPESAFE_API_KEY: 'old-key' })).apiKey).toBeNull()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('caps batches at 1,000 questions even with a large token budget', () => {
    const calls = Array.from({ length: 501 }, (_, i) => ({ ...call, callId: `c${i}` }))
    expect(batchCalls(calls, 0, 262144).map((batch) => batch.length)).toEqual([500, 1])
  })

  it('maps long or invalid call IDs to valid unique question keys and resolves answers', async () => {
    const callId = 'call.with/slashes:' + 'x'.repeat(100)
    const keys = Object.keys(questionsFor({ ...call, callId }))
    expect(keys).toHaveLength(2)
    expect(keys.every((key) => /^[A-Za-z0-9_-]{1,64}$/.test(key))).toBe(true)
    expect(keys).toEqual(Object.keys(questionsFor({ ...call, callId })))
    expect(keys).not.toEqual(Object.keys(questionsFor({ ...call, callId: callId + 'y' })))
    const result = await scoreCalls([
      { ordinal: 1, item: { kind: 'function_call', callId, name: 'shell', argumentsJson: '{}' } },
      { ordinal: 2, item: { kind: 'function_call_output', callId, outputs: [{ type: 'input_text', text: 'out' }] } },
    ], new JevClient({ apiKey: 'test-key', fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
      return new Response(JSON.stringify({ answers: Object.fromEntries(
        Object.keys(body.questions).map((key) => [key, { type: 'noul', noul: 0.1, confidence: 0.9 }]),
      ) }))
    } }), { ...DEFAULT_CONFIG, preserveRecentItems: 0 })
    expect(result.decisions[0]?.action).toBe('drop_call')
  })

  it('treats malformed or out-of-range probabilities as unanswered', () => {
    const response = parseJevResponse(200, true, JSON.stringify({ answers: {
      valid: { type: 'noul', noul: 0.99, confidence: 0.9 },
      nil: null, negative: { noul: -0.1 }, excessive: { noul: 1.1 },
    } }))
    expect(noulAnswer(response, 'valid')).toBe(0.99)
    for (const key of ['nil', 'negative', 'excessive']) expect(noulAnswer(response, key)).toBeUndefined()
  })
})
