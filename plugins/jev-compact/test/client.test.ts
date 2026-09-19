import { describe, expect, it } from 'vitest'

import { buildJevRequest, noulAnswer, parseJevResponse } from '../src/jev/request.js'
import { JevClient } from '../src/jev/client.js'
import type { JevState, JevQuestions } from '../src/jev/types.js'

const state: JevState = { context: 'c', goal: 'g', history: [] }
const questions: JevQuestions = { q1: { type: 'noul', instructions: 'i' } }

describe('buildJevRequest', () => {
  it('builds an authorized POST with model, state and questions', () => {
    const request = buildJevRequest({ apiKey: 'k', model: 'm', baseUrl: 'http://x' }, state, questions)
    expect(request.method).toBe('POST')
    expect(request.url).toBe('http://x')
    expect(request.headers['authorization']).toBe('Bearer k')
    const body = JSON.parse(request.body) as { model: string; state: JevState; questions: JevQuestions }
    expect(body.model).toBe('m')
    expect(body.state).toEqual(state)
    expect(body.questions).toEqual(questions)
  })

  it('defaults to the System One URL and jev-latest', () => {
    const request = buildJevRequest({ apiKey: 'k' }, state, questions)
    expect(request.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect((JSON.parse(request.body) as { model: string }).model).toBe('jev-latest')
  })
})

describe('parseJevResponse', () => {
  it('parses a valid answers payload', () => {
    expect(parseJevResponse(200, true, '{"answers":{"q1":{"noul":0.7}}}')).toEqual({
      answers: { q1: { noul: 0.7 } },
    })
  })

  it('throws on HTTP failure, bad JSON and missing answers', () => {
    expect(() => parseJevResponse(500, false, 'oops')).toThrow('jev: HTTP 500')
    expect(() => parseJevResponse(200, true, 'not json')).toThrow('not JSON')
    expect(() => parseJevResponse(200, true, '{"nope":1}')).toThrow('answers')
  })
})

describe('noulAnswer', () => {
  it('reads probabilities and treats junk as unanswered', () => {
    const response = parseJevResponse(200, true, '{"answers":{"a":{"noul":0.4},"b":{"noul":"x"}}}')
    expect(noulAnswer(response, 'a')).toBe(0.4)
    expect(noulAnswer(response, 'b')).toBeUndefined()
    expect(noulAnswer(response, 'missing')).toBeUndefined()
  })
})

describe('JevClient', () => {
  const okResponse = (): Response =>
    new Response(JSON.stringify({ answers: { q1: { noul: 0.6 } } }), { status: 200 })

  it('asks through the injected transport', async () => {
    let calls = 0
    const client = new JevClient({
      apiKey: 'k',
      fetchImpl: async () => {
        calls += 1
        return okResponse()
      },
    })
    const response = await client.ask(state, questions)
    expect(calls).toBe(1)
    expect(noulAnswer(response, 'q1')).toBe(0.6)
  })

  it('retries retryable failures then succeeds', async () => {
    let calls = 0
    const client = new JevClient({
      apiKey: 'k',
      retryBackoffMs: 1,
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) return new Response('boom', { status: 503 })
        return okResponse()
      },
    })
    const response = await client.ask(state, questions)
    expect(calls).toBe(2)
    expect(noulAnswer(response, 'q1')).toBe(0.6)
  })

  it('does not retry non-retryable failures', async () => {
    let calls = 0
    const client = new JevClient({
      apiKey: 'k',
      retryBackoffMs: 1,
      fetchImpl: async () => {
        calls += 1
        return new Response('denied', { status: 401 })
      },
    })
    await expect(client.ask(state, questions)).rejects.toThrow('HTTP 401')
    expect(calls).toBe(1)
  })

  it('gives up after exhausting retries on network errors', async () => {
    let calls = 0
    const client = new JevClient({
      apiKey: 'k',
      retries: 2,
      retryBackoffMs: 1,
      fetchImpl: async () => {
        calls += 1
        throw new Error('offline')
      },
    })
    await expect(client.ask(state, questions)).rejects.toThrow('offline')
    expect(calls).toBe(3)
  })

  it('requires an API key', async () => {
    const previous = process.env['TYPESAFE_API_KEY']
    delete process.env['TYPESAFE_API_KEY']
    try {
      const client = new JevClient({ fetchImpl: async () => okResponse() })
      await expect(client.ask(state, questions)).rejects.toThrow('TYPESAFE_API_KEY')
    } finally {
      if (previous !== undefined) process.env['TYPESAFE_API_KEY'] = previous
    }
  })
})
