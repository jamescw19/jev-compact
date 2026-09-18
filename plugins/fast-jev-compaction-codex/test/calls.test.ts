import { describe, expect, it } from 'vitest'

import type { StampedHistory } from '../src/ir.js'
import { detectError, pairToolCalls } from '../src/rollout/calls.js'

function stamped(ordinal: number, item: StampedHistory['item']): StampedHistory {
  return { ordinal, item }
}

describe('pairToolCalls', () => {
  it('pairs function calls with their outputs', () => {
    const calls = pairToolCalls([
      stamped(2, { kind: 'function_call', callId: 'a', name: 'shell', argumentsJson: '{"command":"ls"}' }),
      stamped(3, { kind: 'function_call_output', callId: 'a', outputs: [{ type: 'input_text', text: 'ok' }] }),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      callId: 'a',
      kind: 'function_call',
      name: 'shell',
      argumentsJson: '{"command":"ls"}',
      outputText: 'ok',
      outputChars: 2,
      callOrdinal: 2,
      resultOrdinal: 3,
    })
  })

  it('pairs custom tool calls and uses input as arguments', () => {
    const calls = pairToolCalls([
      stamped(1, { kind: 'custom_tool_call', callId: 'b', name: 'exec', input: 'text(1)' }),
      stamped(2, { kind: 'custom_tool_call_output', callId: 'b', outputs: [{ type: 'input_text', text: 'done' }] }),
    ])
    expect(calls[0]).toMatchObject({
      kind: 'custom_tool_call',
      argumentsJson: 'text(1)',
      outputText: 'done',
    })
  })

  it('skips calls without outputs and outputs without calls', () => {
    const calls = pairToolCalls([
      stamped(1, { kind: 'function_call', callId: 'orphan', name: 'shell', argumentsJson: '{}' }),
      stamped(2, { kind: 'function_call_output', callId: 'ghost', outputs: [{ type: 'input_text', text: '?' }] }),
      stamped(3, { kind: 'message', role: 'user', contents: [] }),
    ])
    expect(calls).toEqual([])
  })

  it('keeps the first occurrence of a duplicated call_id', () => {
    const calls = pairToolCalls([
      stamped(1, { kind: 'function_call', callId: 'dup', name: 'first', argumentsJson: '1' }),
      stamped(2, { kind: 'function_call', callId: 'dup', name: 'second', argumentsJson: '2' }),
      stamped(3, { kind: 'function_call_output', callId: 'dup', outputs: [{ type: 'input_text', text: 'out' }] }),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('first')
  })

  it('emits observations in output order and supports multiple pairs', () => {
    const calls = pairToolCalls([
      stamped(1, { kind: 'function_call', callId: 'a', name: 'one', argumentsJson: '{}' }),
      stamped(2, { kind: 'function_call', callId: 'b', name: 'two', argumentsJson: '{}' }),
      stamped(3, { kind: 'function_call_output', callId: 'b', outputs: [{ type: 'input_text', text: 'B' }] }),
      stamped(4, { kind: 'function_call_output', callId: 'a', outputs: [{ type: 'input_text', text: 'A' }] }),
    ])
    expect(calls.map((call) => call.callId)).toEqual(['b', 'a'])
  })
})

describe('detectError', () => {
  it('flags non-zero JSON exit codes', () => {
    expect(detectError('{"exit_code":1,"output":"boom"}')).toBe(true)
    expect(detectError('{"exit_code":127}')).toBe(true)
  })

  it('flags plain-text exit codes', () => {
    expect(detectError('Wall time 0.2s\nexit code: 2\nOutput:\nerr')).toBe(true)
  })

  it('accepts successful outputs', () => {
    expect(detectError('{"exit_code":0,"output":"fine"}')).toBe(false)
    expect(detectError('exit code: 0')).toBe(false)
    expect(detectError('all good')).toBe(false)
  })
})
