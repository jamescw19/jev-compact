import { describe, expect, it } from 'vitest'

import { itemText } from '../src/ir.js'
import { narrowItem, normalizeContent } from '../src/rollout/items.js'

describe('normalizeContent', () => {
  it('accepts a plain string', () => {
    expect(normalizeContent('hello')).toEqual([{ type: 'input_text', text: 'hello' }])
  })

  it('accepts an array of content parts', () => {
    expect(normalizeContent([{ type: 'output_text', text: 'a' }, { text: 'b' }])).toEqual([
      { type: 'output_text', text: 'a' },
      { type: 'text', text: 'b' },
    ])
  })

  it('accepts a single content object', () => {
    expect(normalizeContent({ type: 'input_text', text: 'solo' })).toEqual([
      { type: 'input_text', text: 'solo' },
    ])
  })

  it('maps junk to empty', () => {
    expect(normalizeContent(42)).toEqual([])
    expect(normalizeContent(null)).toEqual([])
    expect(normalizeContent('')).toEqual([])
  })
})

describe('narrowItem', () => {
  it('narrows user/assistant/developer messages', () => {
    const item = narrowItem({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] })
    expect(item).toEqual({
      kind: 'message',
      role: 'assistant',
      contents: [{ type: 'output_text', text: 'hi' }],
    })
  })

  it('degrades messages with unknown roles to other', () => {
    const item = narrowItem({ type: 'message', role: 'system', content: 'x' })
    expect(item.kind).toBe('other')
  })

  it('narrows function calls and keeps arguments as a string', () => {
    expect(
      narrowItem({ type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"a":1}' }),
    ).toEqual({ kind: 'function_call', callId: 'c1', name: 'shell', argumentsJson: '{"a":1}' })
  })

  it('stringifies non-string function call arguments', () => {
    const item = narrowItem({ type: 'function_call', call_id: 'c1', name: 'shell', arguments: { a: 1 } })
    expect(item).toEqual({
      kind: 'function_call',
      callId: 'c1',
      name: 'shell',
      argumentsJson: '{"a":1}',
    })
  })

  it('narrows outputs given as a bare string', () => {
    expect(narrowItem({ type: 'function_call_output', call_id: 'c1', output: 'plain' })).toEqual({
      kind: 'function_call_output',
      callId: 'c1',
      outputs: [{ type: 'input_text', text: 'plain' }],
    })
  })

  it('narrows custom tool calls with string input and status', () => {
    expect(
      narrowItem({ type: 'custom_tool_call', call_id: 'c2', name: 'exec', input: 'text(1)', status: 'completed' }),
    ).toEqual({
      kind: 'custom_tool_call',
      callId: 'c2',
      name: 'exec',
      input: 'text(1)',
      status: 'completed',
    })
  })

  it('narrows reasoning without carrying encrypted content', () => {
    const item = narrowItem({ type: 'reasoning', id: 'rs_9', encrypted_content: 'gAAAA' })
    expect(item).toEqual({ kind: 'reasoning', id: 'rs_9' })
  })

  it('degrades unknown payload types to other with truncated text', () => {
    const item = narrowItem({ type: 'world_state', blob: 'x'.repeat(5000) })
    expect(item.kind).toBe('other')
    if (item.kind === 'other') {
      expect(item.payloadType).toBe('world_state')
      expect(item.text.length).toBeLessThanOrEqual(2000)
    }
  })

  it('degrades non-object payloads to other', () => {
    expect(narrowItem('nope')).toEqual({ kind: 'other', payloadType: 'non-object', text: '"nope"' })
  })
})

describe('itemText', () => {
  it('joins message contents', () => {
    expect(itemText({ kind: 'message', role: 'user', contents: [{ type: 't', text: 'a' }, { type: 't', text: 'b' }] })).toBe('a\nb')
  })

  it('renders function calls as name plus arguments', () => {
    expect(itemText({ kind: 'function_call', callId: 'c', name: 'shell', argumentsJson: '{"x":1}' })).toBe('shell {"x":1}')
  })

  it('renders custom tool calls as their input', () => {
    expect(itemText({ kind: 'custom_tool_call', callId: 'c', name: 'exec', input: 'text(1)' })).toBe('text(1)')
  })

  it('joins output parts and drops empty ones', () => {
    expect(
      itemText({
        kind: 'function_call_output',
        callId: 'c',
        outputs: [
          { type: 'input_text', text: '' },
          { type: 'input_text', text: 'result' },
        ],
      }),
    ).toBe('result')
  })

  it('renders reasoning and other as their text (empty for reasoning)', () => {
    expect(itemText({ kind: 'reasoning', id: 'r' })).toBe('')
    expect(itemText({ kind: 'other', payloadType: 'x', text: 'blob' })).toBe('blob')
  })
})
