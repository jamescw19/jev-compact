import { DEFAULT_JEV_MODEL, SYSTEM_ONE_URL } from './types.js'
import type { JevQuestions, JevResponse, JevState } from './types.js'

export interface JevRequestSpec {
  readonly url: string
  readonly method: 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface JevRequestParams {
  readonly apiKey: string
  readonly model?: string
  readonly baseUrl?: string
}

/** Build the HTTP request for a System One scoring round (transport-agnostic). */
export function buildJevRequest(
  params: JevRequestParams,
  state: JevState,
  questions: JevQuestions,
): JevRequestSpec {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: params.model ?? DEFAULT_JEV_MODEL, state, questions }),
  }
}

/**
 * Validate and parse a System One response. Throws when the payload is not a
 * well-formed answers object so callers can degrade to built-in compaction.
 */
export function parseJevResponse(status: number, ok: boolean, text: string): JevResponse {
  if (!ok) throw new Error(`jev: HTTP ${status}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('jev: response is not JSON')
  }
  const answers = (parsed as { answers?: unknown })?.['answers']
  if (typeof answers !== 'object' || answers === null) {
    throw new Error('jev: response has no answers object')
  }
  return { answers: answers as JevResponse['answers'] }
}

/** The `noul` probability for one question, or undefined when not answered. */
export function noulAnswer(response: JevResponse, name: string): number | undefined {
  const answer = response.answers[name]
  if (answer === undefined) return undefined
  const value = (answer as { noul?: unknown })['noul']
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
