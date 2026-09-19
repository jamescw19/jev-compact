import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeJsonl } from './helpers.js'

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'fast-jev.mjs')

interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run the built CLI artifact as a subprocess, feeding it stdin. */
function runCli(
  args: readonly string[],
  stdin: string,
  env: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end(stdin)
  })
}

describe.skipIf(!existsSync(DIST))('cli (built artifact)', () => {
  let workDir: string
  let dataDir: string

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'jev-cli-'))
    dataDir = path.join(workDir, 'data')
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it('degrades junk PreCompact payloads to an empty harmless outcome', async () => {
    const result = await runCli(['pre-compact'], 'not json', { CODEX_HOME: workDir })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({})
    expect(result.stderr).toContain('unrecognized PreCompact payload')
  })

  it('continues without scoring when no API key is configured', async () => {
    const transcript = path.join(workDir, 'rollout.jsonl')
    await writeFile(
      transcript,
      writeJsonl([
        { timestamp: 't', ordinal: 0, type: 'session_meta', payload: { session_id: 's' } },
        { timestamp: 't', ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: 'hi' } },
      ]),
    )
    const result = await runCli(
      ['pre-compact'],
      JSON.stringify({ session_id: 's', trigger: 'manual', transcript_path: transcript }),
      { CODEX_HOME: workDir },
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ continue: true })
    expect(result.stderr).toContain('TYPESAFE_API_KEY')
  })

  it('no-ops SessionStart for non-compact sources', async () => {
    const result = await runCli(
      ['session-start'],
      JSON.stringify({ session_id: 's', source: 'startup', transcript_path: '/t.jsonl' }),
      { CODEX_HOME: workDir },
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({})
  })

  it('records probe captures and lists them', async () => {
    const record = await runCli(['probe', 'record', 'PreCompact'], '{"trigger":"manual"}', {
      CODEX_HOME: workDir,
      PLUGIN_DATA: dataDir,
    })
    expect(record.code).toBe(0)
    const probeDir = path.join(dataDir, 'probe')
    const captured = await readdir(probeDir)
    expect(captured.some((name) => name.includes('-PreCompact-'))).toBe(true)

    const list = await runCli(['probe', 'ls'], '', { CODEX_HOME: workDir, PLUGIN_DATA: dataDir })
    expect(list.stdout).toContain('-PreCompact-')
  })

  it('prints usage for unknown commands and never exits nonzero', async () => {
    const result = await runCli(['bogus'], '')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('unknown command')
    const help = await runCli(['--help'], '')
    expect(help.stdout).toContain('usage:')
  })
})
