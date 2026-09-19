import { itemText } from '../ir.js'
import type { HistoryItem, StampedHistory } from '../ir.js'

export type ToolCallKind = 'function_call' | 'custom_tool_call'

export interface ToolCallObservation {
  readonly callId: string
  readonly kind: ToolCallKind
  readonly name: string
  readonly argumentsJson: string
  readonly outputText: string
  readonly outputChars: number
  readonly isError: boolean
  /** Rollout line of the call item itself. */
  readonly callOrdinal: number
  /** Rollout line of the matching output item. */
  readonly resultOrdinal: number
}

interface PendingCall {
  readonly kind: ToolCallKind
  readonly name: string
  readonly argumentsJson: string
  readonly callOrdinal: number
}

function isCallKind(item: HistoryItem): item is Extract<HistoryItem, { kind: ToolCallKind }> {
  return item.kind === 'function_call' || item.kind === 'custom_tool_call'
}

function isOutputKind(
  item: HistoryItem,
): item is Extract<HistoryItem, { kind: 'function_call_output' | 'custom_tool_call_output' }> {
  return item.kind === 'function_call_output' || item.kind === 'custom_tool_call_output'
}

/**
 * Pair `function_call` / `custom_tool_call` items with their outputs by
 * `call_id`, in rollout order. Calls without a matching output are not
 * observable (nothing to score about their result) and are skipped; a
 * duplicated `call_id` keeps the first occurrence.
 */
export function pairToolCalls(items: readonly StampedHistory[]): readonly ToolCallObservation[] {
  const pending = new Map<string, PendingCall>()
  const observations: ToolCallObservation[] = []
  for (const { ordinal, item } of items) {
    if (isCallKind(item)) {
      if (!pending.has(item.callId)) {
        pending.set(item.callId, {
          kind: item.kind,
          name: item.name,
          argumentsJson: item.kind === 'function_call' ? item.argumentsJson : item.input,
          callOrdinal: ordinal,
        })
      }
      continue
    }
    if (isOutputKind(item)) {
      const call = pending.get(item.callId)
      if (call === undefined) continue
      pending.delete(item.callId)
      const outputText = itemText(item)
      observations.push({
        callId: item.callId,
        kind: call.kind,
        name: call.name,
        argumentsJson: call.argumentsJson,
        outputText,
        outputChars: outputText.length,
        isError: detectError(outputText),
        callOrdinal: call.callOrdinal,
        resultOrdinal: ordinal,
      })
    }
  }
  return observations
}

const NONZERO_EXIT_PATTERNS: readonly RegExp[] = [
  /"exit_code"\s*:\s*-?[1-9]\d*/i,
  /\bexit code\s*[:=]\s*-?[1-9]\d*/i,
]

/**
 * Best-effort error detection from output text alone (rollout outputs carry
 * no structured error flag). A non-zero exit code is the reliable signal.
 */
export function detectError(outputText: string): boolean {
  return NONZERO_EXIT_PATTERNS.some((pattern) => pattern.test(outputText))
}
