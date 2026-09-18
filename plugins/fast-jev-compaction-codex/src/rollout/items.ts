import type { ContentPart, HistoryItem, MessageRole } from '../ir.js'

const MESSAGE_ROLES: readonly MessageRole[] = ['user', 'assistant', 'developer']

const MAX_OTHER_TEXT = 2000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Normalize the many shapes a content field can take (`string`, a single
 * content object, an array of content objects, or anything else) into
 * `ContentPart[]`.
 */
export function normalizeContent(value: unknown): readonly ContentPart[] {
  if (typeof value === 'string') {
    return value === '' ? [] : [{ type: 'input_text', text: value }]
  }
  const entries = Array.isArray(value) ? value : isRecord(value) ? [value] : []
  const parts: ContentPart[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      parts.push({ type: 'input_text', text: entry })
    } else if (isRecord(entry)) {
      parts.push({ type: asText(entry['type']) || 'text', text: asText(entry['text']) })
    }
  }
  return parts
}

function joinText(parts: readonly ContentPart[]): string {
  return parts
    .map((part) => part.text)
    .filter((text) => text !== '')
    .join('\n')
}

/**
 * Narrow one raw `response_item` payload into a `HistoryItem`. Unknown or
 * malformed payloads never throw — they degrade to the `other` variant so a
 * single odd line can not break a whole transcript.
 */
export function narrowItem(payload: unknown): HistoryItem {
  if (!isRecord(payload)) {
    return { kind: 'other', payloadType: 'non-object', text: JSON.stringify(payload) ?? '' }
  }
  switch (payload['type']) {
    case 'message': {
      const role = asText(payload['role'])
      if (!MESSAGE_ROLES.includes(role as MessageRole)) {
        return other(payload)
      }
      return {
        kind: 'message',
        role: role as MessageRole,
        contents: normalizeContent(payload['content']),
      }
    }
    case 'function_call':
      return {
        kind: 'function_call',
        callId: asText(payload['call_id']),
        name: asText(payload['name']),
        argumentsJson:
          typeof payload['arguments'] === 'string'
            ? payload['arguments']
            : JSON.stringify(payload['arguments'] ?? null),
      }
    case 'function_call_output':
      return {
        kind: 'function_call_output',
        callId: asText(payload['call_id']),
        outputs: normalizeContent(payload['output']),
      }
    case 'custom_tool_call':
      return {
        kind: 'custom_tool_call',
        callId: asText(payload['call_id']),
        name: asText(payload['name']),
        input:
          typeof payload['input'] === 'string'
            ? payload['input']
            : JSON.stringify(payload['input'] ?? null),
        status: typeof payload['status'] === 'string' ? payload['status'] : undefined,
      }
    case 'custom_tool_call_output':
      return {
        kind: 'custom_tool_call_output',
        callId: asText(payload['call_id']),
        outputs: normalizeContent(payload['output']),
      }
    case 'reasoning':
      return {
        kind: 'reasoning',
        id: typeof payload['id'] === 'string' ? payload['id'] : undefined,
      }
    default:
      return other(payload)
  }
}

function other(payload: Record<string, unknown>): HistoryItem {
  return {
    kind: 'other',
    payloadType: asText(payload['type']) || 'unknown',
    text: (JSON.stringify(payload) ?? '').slice(0, MAX_OTHER_TEXT),
  }
}
