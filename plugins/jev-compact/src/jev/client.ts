import { buildJevRequest, parseJevResponse } from './request.js'
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js'

export interface JevClientOptions {
  /** Defaults to `process.env.GEMINI_API_KEY`. */
  readonly apiKey?: string
  readonly model?: string
  readonly baseUrl?: string
  /** Per-request timeout. Default 60s. */
  readonly timeoutMs?: number
  /** Retries for retryable failures (network, 429, 5xx). Default 1. */
  readonly retries?: number
  /** Backoff between retries. Default 2s. */
  readonly retryBackoffMs?: number
  /** Injectable transport. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_RETRIES = 1
const DEFAULT_RETRY_BACKOFF_MS = 2_000

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Default `JevAsker` backed by `fetch` against the Gemini Decisions
 * endpoint, with a per-request timeout and a single retry.
 */
export class JevClient implements JevAsker {
  private readonly options: JevClientOptions

  constructor(options: JevClientOptions = {}) {
    this.options = options
  }

  private apiKey(): string {
    const key = this.options.apiKey ?? process.env['GEMINI_API_KEY']
    if (key === undefined || key.trim() === '') {
      throw new Error('GEMINI_API_KEY is not configured')
    }
    return key.trim()
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const request = buildJevRequest(
      { apiKey: this.apiKey(), model: this.options.model, baseUrl: this.options.baseUrl },
      state,
      questions,
    )
    const doFetch = this.options.fetchImpl ?? fetch
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const retries = this.options.retries ?? DEFAULT_RETRIES
    const backoffMs = this.options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS

    let lastError: unknown = new Error('gemini: request never ran')
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(backoffMs)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let status: number
      let ok: boolean
      let text: string
      try {
        const response = await doFetch(request.url, {
          method: request.method,
          headers: { ...request.headers },
          body: request.body,
          signal: controller.signal,
        })
        status = response.status
        ok = response.ok
        text = await response.text()
      } catch (error) {
        lastError = error
        continue
      } finally {
        clearTimeout(timer)
      }
      // Transport-level failures above are retryable; protocol errors below
      // (bad status, malformed body) propagate without a retry.
      if (ok) return parseJevResponse(status, true, text)
      if (!isRetryable(status)) return parseJevResponse(status, false, text)
      lastError = new Error(`gemini: HTTP ${status}`)
    }
    throw lastError
  }
}
