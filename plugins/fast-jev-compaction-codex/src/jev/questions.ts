import type { ToolCallObservation } from '../rollout/calls.js'
import type { JevQuestions } from './types.js'

/** Rough per-call question overhead used to size batches inside the request budget. */
const PER_CALL_QUESTION_TOKENS = 48
const REQUEST_OVERHEAD_TOKENS = 64

/**
 * The two `noul` questions per tool call: does the call itself (that it
 * happened, with its input) still matter, and is the full output still
 * needed verbatim (re-running would not do).
 */
export function questionsFor(call: ToolCallObservation): JevQuestions {
  return {
    [`call_${call.callId}`]: {
      type: 'noul',
      instructions:
        `Tool call ${call.name} (${call.callId}) should stay in the history: knowing this call ` +
        `was made, with its input ${call.argumentsJson.slice(0, 200)}, still matters for what comes next`,
      criteria: { true: 'still matters', false: 'droppable together with its output' },
    },
    [`result_${call.callId}`]: {
      type: 'noul',
      instructions:
        `The full output of the ${call.name} call (${call.callId}, ${call.outputChars} chars) should stay ` +
        'in the history verbatim: its contents are still needed and re-running the tool would not reproduce them',
      criteria: { true: 'needed verbatim', false: 'droppable, re-running can recover it' },
    },
  }
}

/**
 * Split candidate calls into batches whose question overhead fits
 * `maxRequestTokens - stateTokens`. Every batch is independently answerable
 * against the same state. Always produces at least one batch when calls exist.
 */
export function batchCalls(
  calls: readonly ToolCallObservation[],
  stateTokenCount: number,
  maxRequestTokens: number,
): ToolCallObservation[][] {
  if (calls.length === 0) return []
  const budget = maxRequestTokens - stateTokenCount - REQUEST_OVERHEAD_TOKENS
  const perBatch = Math.max(1, Math.floor(budget / PER_CALL_QUESTION_TOKENS))
  const batches: ToolCallObservation[][] = []
  for (let index = 0; index < calls.length; index += perBatch) {
    batches.push(calls.slice(index, index + perBatch))
  }
  return batches
}
