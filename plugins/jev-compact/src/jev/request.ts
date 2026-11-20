import { DEFAULT_DECISION_MODEL, GEMINI_DECISIONS_URL } from './types.js'
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

/** Build a Gemini Decisions request; conversation state must be serialized text. */
export function buildJevRequest(
  params: JevRequestParams,
  state: JevState,
  questions: JevQuestions,
): JevRequestSpec {
  return {
    url: params.baseUrl ?? GEMINI_DECISIONS_URL,
    method: 'POST',
    headers: {
      'x-goog-api-key': params.apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_DECISION_MODEL,
      input: JSON.stringify(state),
      questions,
    }),
  }
}

/**
 * Validate and parse a Gemini Decisions response. Throws when the payload is not a
 * well-formed answers object so callers can degrade to built-in compaction.
 */
export function parseJevResponse(status: number, ok: boolean, text: string): JevResponse {
  if (!ok) throw new Error(`gemini: HTTP ${status}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('gemini: response is not JSON')
  }
  const answers = (parsed as { answers?: unknown })?.['answers']
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
    throw new Error('gemini: response has no answers object')
  }
  return { answers: answers as JevResponse['answers'] }
}

/** The `noul` probability for one question, or undefined when not answered. */
export function noulAnswer(response: JevResponse, name: string): number | undefined {
  const answer = response.answers[name]
  if (typeof answer !== 'object' || answer === null) return undefined
  const value = (answer as { noul?: unknown })['noul']
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined
}
