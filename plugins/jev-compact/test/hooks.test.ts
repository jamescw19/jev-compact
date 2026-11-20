import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG } from '../src/config.js'
import type { FastJevConfig } from '../src/config.js'
import { parsePreCompactInput, runPreCompact } from '../src/hooks/pre-compact.js'
import { parseSessionStartInput, runSessionStart } from '../src/hooks/session-start.js'
import { FakeAsker, writeJsonl } from './helpers.js'

let workDir: string
let dataDir: string

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'jev-hooks-'))
  dataDir = path.join(workDir, 'data')
  await writeFile(path.join(workDir, 'fast-jev-compaction.json'), '{}')
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function configWith(overrides: Partial<FastJevConfig> = {}): FastJevConfig {
  return { ...DEFAULT_CONFIG, dataDir, logLevel: 'silent', ...overrides }
}

async function transcriptWithCalls(): Promise<string> {
  const lines = [
    { timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 'sess-1', cwd: '/p' } },
    { timestamp: 't', ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the bug' }] } },
    { timestamp: 't', ordinal: 2, type: 'response_item', payload: { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{"command":"cargo test"}' } },
    { timestamp: 't', ordinal: 3, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_a', output: [{ type: 'input_text', text: '127 test results passed' }] } },
    { timestamp: 't', ordinal: 4, type: 'response_item', payload: { type: 'function_call', call_id: 'call_b', name: 'shell', arguments: '{"command":"ls"}' } },
    { timestamp: 't', ordinal: 5, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_b', output: [{ type: 'input_text', text: 'src' }] } },
  ]
  const file = path.join(workDir, 'rollout-test.jsonl')
  await writeFile(file, writeJsonl(lines))
  return file
}

describe('parsePreCompactInput', () => {
  it('parses session/trigger/transcript and tolerates junk', () => {
    const input = parsePreCompactInput(
      JSON.stringify({ session_id: 's', turn_id: 't1', trigger: 'auto', transcript_path: '/r.jsonl' }),
    )
    expect(input).toEqual({ sessionId: 's', turnId: 't1', trigger: 'auto', transcriptPath: '/r.jsonl' })
    expect(parsePreCompactInput('not json')).toBeNull()
    expect(parsePreCompactInput(JSON.stringify({ trigger: 'manual' }))).toBeNull()
  })
})

describe('runPreCompact', () => {
  it('scores, archives, and reports a summary message', async () => {
    const file = await transcriptWithCalls()
    const asker = new FakeAsker({ call_call_a: 0.9, result_call_a: 0.9, call_call_b: 0.1, result_call_b: 0.1 })
    const outcome = await runPreCompact(
      { sessionId: 'sess-1', trigger: 'manual', transcriptPath: file },
      configWith({ preserveRecentItems: 0 }),
      process.env,
      asker,
    )
    expect(outcome.continue).toBe(true)
    expect(outcome.systemMessage).toContain('scored 2 tool calls')
    expect(asker.asked).toHaveLength(1)
  })

  it('archives with correct decisions on disk', async () => {
    const file = await transcriptWithCalls()
    const asker = new FakeAsker({ call_call_a: 0.9, result_call_a: 0.9, call_call_b: 0.1, result_call_b: 0.1 })
    await runPreCompact(
      { sessionId: 'sess-1', trigger: 'manual', transcriptPath: file },
      configWith({ preserveRecentItems: 0 }),
      process.env,
      asker,
    )
    const { readdir } = await import('node:fs/promises')
    const dir = path.join(dataDir, 'decisions', path.basename(file))
    const name = (await readdir(dir)).find((entry) => entry.endsWith('.json'))
    expect(name).toBeDefined()
    const archive = JSON.parse(await readFile(path.join(dir, name as string), 'utf8')) as {
      items: { callId: string; action: string }[]
      sessionId: string
    }
    expect(archive.sessionId).toBe('sess-1')
    expect(archive.items.map((item) => ({ callId: item.callId, action: item.action }))).toEqual([
      { callId: 'call_a', action: 'keep' },
      { callId: 'call_b', action: 'drop_call' },
    ])
  })

  it('no-ops without an API key and no injected asker', async () => {
    const outcome = await runPreCompact(
      { sessionId: 's', trigger: 'manual', transcriptPath: await transcriptWithCalls() },
      configWith({ apiKey: null }),
    )
    expect(outcome.continue).toBe(true)
    expect(outcome.note).toContain('GEMINI_API_KEY')
  })

  it('no-ops when there is nothing live to score', async () => {
    const empty = path.join(workDir, 'rollout-empty.jsonl')
    await writeFile(empty, writeJsonl([{ timestamp: 't', ordinal: 0, type: 'session_meta', payload: {} }]))
    const outcome = await runPreCompact(
      { sessionId: 's', trigger: 'manual', transcriptPath: empty },
      configWith({ apiKey: 'k' }),
      process.env,
      new FakeAsker({}),
    )
    expect(outcome.continue).toBe(true)
    expect(outcome.note).toContain('nothing new')
  })
})

describe('runSessionStart', () => {
  it('parses input and rejects non-compact sources', async () => {
    expect(parseSessionStartInput(JSON.stringify({ session_id: 's', source: 'startup', transcript_path: '/t' }))).toEqual({
      sessionId: 's',
      source: 'startup',
      transcriptPath: '/t',
    })
    const outcome = await runSessionStart(
      JSON.stringify({ session_id: 's', source: 'startup', transcript_path: '/t' }),
      configWith(),
    )
    expect(outcome.hookSpecificOutput).toBeUndefined()
  })

  it('re-injects lost critical outputs after compaction, then consumes the archive', async () => {
    const file = await transcriptWithCalls()
    const compactedFile = path.join(workDir, 'rollout-compacted.jsonl')
    const asker = new FakeAsker({ call_call_a: 0.9, result_call_a: 0.9, call_call_b: 0.9, result_call_b: 0.1 })
    await runPreCompact(
      { sessionId: 'sess-1', trigger: 'manual', transcriptPath: file },
      configWith({ preserveRecentItems: 0 }),
      process.env,
      asker,
    )
    // Simulate post-compaction transcript: both tool calls dropped, summary only.
    await writeFile(
      compactedFile,
      writeJsonl([
        { timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 'sess-1' } },
        { timestamp: 't', ordinal: 1, type: 'compacted', payload: { message: 'summary', replacement_history: [] } },
        { timestamp: 't', ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'summary of fixing the bug' }] } },
      ]),
    )
    const stdin = JSON.stringify({ session_id: 'sess-1', source: 'compact', transcript_path: compactedFile })
    const outcome = await runSessionStart(stdin, configWith({ preserveRecentItems: 0 }))
    expect(outcome.hookSpecificOutput?.hookEventName).toBe('SessionStart')
    expect(outcome.hookSpecificOutput?.additionalContext).toContain('127 test results passed')
    expect(outcome.hookSpecificOutput?.additionalContext).toContain('re-run the tool if needed')
        // SessionStart wire schema only allows hookSpecificOutput — extra fields
    // risk strict-validation rejection of the whole payload.
    expect(outcome.suppressOutput).toBeUndefined()

    // Second invocation finds the archive consumed — no duplicate injection.
    const second = await runSessionStart(stdin, configWith({ preserveRecentItems: 0 }))
    expect(second.hookSpecificOutput).toBeUndefined()
  })

  it('stays silent when the summary already preserved the content', async () => {
    const file = await transcriptWithCalls()
    await runPreCompact(
      { sessionId: 'sess-1', trigger: 'manual', transcriptPath: file },
      configWith({ preserveRecentItems: 0 }),
      process.env,
      new FakeAsker({ call_call_a: 0.9, result_call_a: 0.9, call_call_b: 0.1, result_call_b: 0.1 }),
    )
    const keptFile = path.join(workDir, 'rollout-kept.jsonl')
    await writeFile(
      keptFile,
      writeJsonl([
        { timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 'sess-1' } },
        { timestamp: 't', ordinal: 1, type: 'compacted', payload: { message: '', replacement_history: [{ type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{}' }, { type: 'function_call_output', call_id: 'call_a', output: '127 test results passed' }] } },
      ]),
    )
    const outcome = await runSessionStart(
      JSON.stringify({ session_id: 'sess-1', source: 'compact', transcript_path: keptFile }),
      configWith({ preserveRecentItems: 0 }),
    )
    expect(outcome.hookSpecificOutput).toBeUndefined()
  })
})
