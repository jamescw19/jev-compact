import { createHash } from 'node:crypto'

import type { ToolCallObservation } from '../rollout/calls.js'
import type { JevQuestions } from './types.js'

/** Rough per-call question overhead used to size batches inside the request budget. */
const PER_CALL_QUESTION_TOKENS = 48
const REQUEST_OVERHEAD_TOKENS = 64

/** Gemini question keys allow 64 ASCII letters, digits, underscores or hyphens. */
export function questionKeys(callId: string): { call: string; result: string } {
  // Reserve hash_ for hashed IDs, and hash raw IDs with that prefix too.
  const id =
    /^[A-Za-z0-9_-]{1,57}$/.test(callId) && !callId.startsWith('hash_')
      ? callId
      : `hash_${createHash('sha256').update(callId).digest('hex').slice(0, 48)}`
  return { call: `call_${id}`, result: `result_${id}` }
}

/**
 * The two `noul` questions per tool call: does the call itself (that it
 * happened, with its input) still matter, and is the full output still
 * needed verbatim (re-running would not do).
 */
export function questionsFor(call: ToolCallObservation): JevQuestions {
  const keys = questionKeys(call.callId)
  return {
    [keys.call]: {
      type: 'noul',
      instructions:
        `Tool call ${call.name} (${call.callId}) should stay in the history: knowing this call ` +
        `was made, with its input ${call.argumentsJson.slice(0, 200)}, still matters for what comes next`,
      criteria: {
        true_description: 'still matters',
        false_description: 'droppable together with its output',
      },
    },
    [keys.result]: {
      type: 'noul',
      instructions:
        `The full output of the ${call.name} call (${call.callId}, ${call.outputChars} chars) should stay ` +
        'in the history verbatim: its contents are still needed and re-running the tool would not reproduce them',
      criteria: {
        true_description: 'needed verbatim',
        false_description: 'droppable, re-running can recover it',
      },
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
  // Two questions per call; Gemini permits at most 1,000 questions per request.
  const perBatch = Math.min(500, Math.max(1, Math.floor(budget / PER_CALL_QUESTION_TOKENS)))
  const batches: ToolCallObservation[][] = []
  for (let index = 0; index < calls.length; index += perBatch) {
    batches.push(calls.slice(index, index + perBatch))
  }
  return batches
}
