/** Gemini Decisions scoring types. Jev names remain for upstream compatibility. */

export const GEMINI_DECISIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/decisions'
export const DEFAULT_DECISION_MODEL = 'gemini-decision-1'

export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
  readonly criteria?: { readonly true_description?: string; readonly false_description?: string }
}

export type JevQuestions = Record<string, NoulQuestion>

export interface JevAnswer {
  readonly noul: number
}

export interface JevResponse {
  readonly answers: Readonly<Record<string, JevAnswer>>
}

export interface StateEntryCall {
  readonly id: string
  readonly name: string
  readonly input: string
}

export interface StateEntryResult {
  readonly id: string
  readonly chars: number
}

export interface StateEntry {
  /** Rollout ordinal of the originating item. */
  readonly i: number
  readonly role: 'user' | 'assistant' | 'developer' | 'tool'
  readonly text: string
  readonly call?: StateEntryCall
  readonly result?: StateEntryResult
}

export interface JevState {
  readonly context: string
  readonly goal: string
  readonly history: readonly StateEntry[]
}

/** Transport seam — injectable so scoring is testable without network. */
export interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>
}
