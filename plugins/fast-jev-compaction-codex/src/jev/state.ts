import { itemText } from '../ir.js'
import type { JevState, StateEntry } from './types.js'
import type { StampedHistory } from '../ir.js'

export const STATE_CONTEXT =
  'A coding session is being compacted to free context. `history` lists the conversation ' +
  'oldest first; tool outputs are replaced by short notes and long texts may be shortened. ' +
  'Each question asks whether one tool call — or that call’s full output — still needs to ' +
  'remain available verbatim. Whatever is dropped is gone permanently, though the assistant ' +
  'can re-run tools or re-read files.'

export type StateStage =
  | 'full'
  | 'inputs-1000'
  | 'inputs-200'
  | 'inputs-60'
  | 'texts-abridged'
  | 'old-collapsed'
  | 'old-calls-compacted'
  | 'old-dropped'
  | 'over-budget'

export interface FitOptions {
  readonly maxStateTokens: number
  readonly preserveRecentItems: number
}

export interface FittedState {
  readonly state: JevState
  readonly stage: StateStage
}

const STAGE_INPUT_LIMITS: readonly { stage: StateStage; maxInputChars: number }[] = [
  { stage: 'inputs-1000', maxInputChars: 1000 },
  { stage: 'inputs-200', maxInputChars: 200 },
  { stage: 'inputs-60', maxInputChars: 60 },
]

const ABRIDGED_TEXT_CHARS = 400
const COLLAPSED_TEXT_CHARS = 80
const ELLIPSIS = '…'

/**
 * Token estimate without a tokenizer: CJK counts ~1 token per char, letters
 * ~1 per 6, digits ~0.5 each, everything else ~0.9. Calibrated to land above
 * real counts so budgets stay conservative.
 */
export function estimateTokens(text: string): number {
  let wide = 0
  let letters = 0
  let digits = 0
  let other = 0
  for (const char of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char)) wide += 1
    else if (/[A-Za-z]/.test(char)) letters += 1
    else if (/[0-9]/.test(char)) digits += 1
    else other += 1
  }
  return Math.ceil(wide + letters / 6 + digits / 2 + other * 0.9)
}

export function stateTokens(state: JevState): number {
  return estimateTokens(JSON.stringify(state))
}

/** Default goal: the last three user prompts, each capped at 500 chars. */
export function goalFromItems(items: readonly StampedHistory[]): string {
  const prompts: string[] = []
  for (let index = items.length - 1; index >= 0 && prompts.length < 3; index -= 1) {
    const stamped = items[index]
    const item = stamped?.item
    if (item === undefined || item.kind !== 'message' || item.role !== 'user') continue
    const text = itemText(item).trim()
    if (text === '') continue
    prompts.unshift(text.slice(0, 500))
  }
  return prompts.join('\n---\n')
}

/** Build the full (uncompressed) Jev state from live transcript items. */
export function buildState(items: readonly StampedHistory[], goal?: string): JevState {
  const history: StateEntry[] = []
  for (const { ordinal, item } of items) {
    switch (item.kind) {
      case 'message':
      case 'other':
        history.push({
          i: ordinal,
          role: item.kind === 'message' ? item.role : 'developer',
          text: itemText(item),
        })
        break
      case 'function_call':
      case 'custom_tool_call':
        history.push({
          i: ordinal,
          role: 'assistant',
          text: '',
          call: {
            id: item.callId,
            name: item.name,
            input: item.kind === 'function_call' ? item.argumentsJson : item.input,
          },
        })
        break
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const text = itemText(item)
        history.push({
          i: ordinal,
          role: 'tool',
          text: `output present, ${text.length} chars (omitted)`,
          result: { id: item.callId, chars: text.length },
        })
        break
      }
      case 'reasoning':
        break
    }
  }
  return {
    context: STATE_CONTEXT,
    goal: goal ?? goalFromItems(items),
    history,
  }
}

function pinnedOrdinals(items: readonly StampedHistory[], preserveRecentItems: number): Set<number> {
  const pinned = new Set<number>()
  for (let index = Math.max(0, items.length - preserveRecentItems); index < items.length; index += 1) {
    const ordinal = items[index]?.ordinal
    if (ordinal !== undefined) pinned.add(ordinal)
  }
  return pinned
}

function cap(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + ELLIPSIS
}

function headTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.7)
  const tail = maxChars - head
  return `${text.slice(0, head)}${ELLIPSIS}[${text.length - maxChars} chars omitted]${text.slice(text.length - tail)}`
}

function transform(
  state: JevState,
  pinned: Set<number>,
  mutate: (entry: StateEntry) => StateEntry,
): JevState {
  return { ...state, history: state.history.map((entry) => (pinned.has(entry.i) ? entry : mutate(entry))) }
}

/**
 * Compress the state in stages until it fits `maxStateTokens`. Recent items
 * (the pinned window) are never touched. If every stage is exhausted the
 * final form is returned with stage `over-budget` — fitting is best-effort
 * because a hook must never fail the compaction.
 */
export function fitState(items: readonly StampedHistory[], options: FitOptions): FittedState {
  const pinned = pinnedOrdinals(items, options.preserveRecentItems)
  let stage: StateStage = 'full'
  let state = buildState(items)

  const overBudget = (): boolean => stateTokens(state) > options.maxStateTokens

  for (const { stage: nextStage, maxInputChars } of STAGE_INPUT_LIMITS) {
    if (!overBudget()) return { state, stage }
    stage = nextStage
    state = transform(state, pinned, (entry) =>
      entry.call === undefined ? entry : { ...entry, call: { ...entry.call, input: cap(entry.call.input, maxInputChars) } },
    )
  }

  if (overBudget()) {
    stage = 'texts-abridged'
    state = transform(state, pinned, (entry) =>
      entry.text.length <= ABRIDGED_TEXT_CHARS ? entry : { ...entry, text: headTail(entry.text, ABRIDGED_TEXT_CHARS) },
    )
  }

  if (overBudget()) {
    stage = 'old-collapsed'
    state = transform(state, pinned, (entry) =>
      entry.call !== undefined || entry.result !== undefined || entry.text.length <= COLLAPSED_TEXT_CHARS
        ? entry
        : { ...entry, text: cap(entry.text, COLLAPSED_TEXT_CHARS) },
    )
  }

  if (overBudget()) {
    stage = 'old-calls-compacted'
    state = transform(state, pinned, (entry) => {
      if (entry.call !== undefined) {
        return { ...entry, text: `called ${entry.call.name} (input omitted)`, call: undefined }
      }
      if (entry.result !== undefined) {
        return { ...entry, text: `output present, ${entry.result.chars} chars (omitted)` }
      }
      return entry
    })
  }

  if (overBudget()) {
    stage = 'old-dropped'
    state = { ...state, history: state.history.filter((entry) => pinned.has(entry.i) || entry.call !== undefined || entry.result !== undefined) }
  }

  if (overBudget()) stage = 'over-budget'
  return { state, stage }
}
