/** TypeSafe System One (Jev) scoring protocol types and transport seam. */

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone'
export const DEFAULT_JEV_MODEL = 'jev-latest'

export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
  readonly criteria?: { readonly true?: string; readonly false?: string }
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
