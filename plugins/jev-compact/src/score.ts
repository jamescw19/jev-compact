import { pairToolCalls } from './rollout/calls.js'
import type { ToolCallObservation } from './rollout/calls.js'
import { batchCalls, questionKeys, questionsFor } from './jev/questions.js'
import { fitState, stateTokens } from './jev/state.js'
import type { StateStage } from './jev/state.js'
import { noulAnswer } from './jev/request.js'
import type { JevAsker, JevState } from './jev/types.js'
import { recentOrdinals } from './ir.js'
import type { StampedHistory } from './ir.js'

export interface ScoreOptions {
  readonly keepThreshold: number
  readonly preserveRecentItems: number
  readonly maxStateTokens: number
  readonly maxRequestTokens: number
  /** Wall-clock cap across all requests; unscored calls default to keep. */
  readonly deadlineMs?: number
  readonly goal?: string
}

export const DEFAULT_SCORE_OPTIONS: ScoreOptions = {
  keepThreshold: 0.5,
  preserveRecentItems: 8,
  maxStateTokens: 25000,
  maxRequestTokens: 30000,
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call'

export interface CallDecision {
  readonly call: ToolCallObservation
  readonly keepCall: number
  readonly keepResult: number
  readonly action: CallAction
  readonly pinned: boolean
  readonly reason: 'pinned' | 'scored' | 'unanswered'
}

export interface ScoreResult {
  readonly decisions: readonly CallDecision[]
  readonly stateStage: StateStage
  readonly requests: number
  /** Batches that could not be scored (error/deadline) — their calls stay keep. */
  readonly failedBatches: number
  readonly asked: boolean
}

function decideAction(keepCall: number, keepResult: number, threshold: number): CallAction {
  if (keepResult >= threshold) return 'keep'
  if (keepCall >= threshold) return 'drop_result'
  return 'drop_call'
}

/**
 * Score every observable tool call in the live segment: pin the most recent
 * window, fit the state into the token budget, batch the remaining calls,
 * and turn `noul` probabilities into three-level keep decisions. Scoring
 * failure of a batch degrades that batch to unanswered (keep) — never throws.
 */
export async function scoreCalls(
  items: readonly StampedHistory[],
  asker: JevAsker,
  partial?: Partial<ScoreOptions>,
): Promise<ScoreResult> {
  const options: ScoreOptions = { ...DEFAULT_SCORE_OPTIONS, ...partial }
  const calls = pairToolCalls(items)
  if (calls.length === 0) {
    return { decisions: [], stateStage: 'full', requests: 0, failedBatches: 0, asked: false }
  }

  // Pin by list position, not rollout line number — rollouts interleave
  // event/usage lines, so line-number windows would often miss the latest calls.
  const pinned = recentOrdinals(items, options.preserveRecentItems)
  const isPinned = (call: ToolCallObservation): boolean => pinned.has(call.resultOrdinal)

  const pinnedDecisions: CallDecision[] = calls
    .filter(isPinned)
    .map((call) => ({ call, keepCall: 1, keepResult: 1, action: 'keep', pinned: true, reason: 'pinned' }))
  const candidates = calls.filter((call) => !isPinned(call))

  if (candidates.length === 0) {
    return { decisions: pinnedDecisions, stateStage: 'full', requests: 0, failedBatches: 0, asked: false }
  }

  const fitted = fitState(items, {
    maxStateTokens: options.maxStateTokens,
    preserveRecentItems: options.preserveRecentItems,
  })
  const tokens = stateTokens(fitted.state)
  const batches = batchCalls(candidates, tokens, options.maxRequestTokens)
  const deadline = options.deadlineMs === undefined ? undefined : Date.now() + options.deadlineMs

  let requests = 0
  let failedBatches = 0
  const decisions: CallDecision[] = []
  for (const batch of batches) {
    if (deadline !== undefined && Date.now() > deadline) {
      failedBatches += 1
      decisions.push(...batch.map((call) => unanswered(call)))
      continue
    }
    requests += 1
    const scored = await scoreBatch(batch, fitted.state, asker, options.keepThreshold)
    if (scored === null) failedBatches += 1
    decisions.push(...(scored ?? batch.map(unanswered)))
  }
  return {
    decisions: [...pinnedDecisions, ...decisions],
    stateStage: fitted.stage,
    requests,
    failedBatches,
    asked: true,
  }
}

function unanswered(call: ToolCallObservation): CallDecision {
  return { call, keepCall: 1, keepResult: 1, action: 'keep', pinned: false, reason: 'unanswered' }
}

/** null = the whole batch failed and its calls stay keep/unanswered. */
async function scoreBatch(
  batch: readonly ToolCallObservation[],
  state: JevState,
  asker: JevAsker,
  threshold: number,
): Promise<CallDecision[] | null> {
  const questions = batch.reduce<Record<string, ReturnType<typeof questionsFor>[string]>>(
    (all, call) => ({ ...all, ...questionsFor(call) }),
    {},
  )
  try {
    const response = await asker.ask(state, questions)
    return batch.map((call) => {
      const keys = questionKeys(call.callId)
      const keepCall = noulAnswer(response, keys.call) ?? 1
      const keepResult = noulAnswer(response, keys.result) ?? 1
      return {
        call,
        keepCall,
        keepResult,
        action: decideAction(keepCall, keepResult, threshold),
        pinned: false,
        reason: noulAnswer(response, keys.call) === undefined ? 'unanswered' : 'scored',
      } as const
    })
  } catch {
    return null
  }
}
