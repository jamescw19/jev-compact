import { PassThrough } from 'node:stream'

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { main } from '../src/cli.js'
import { runProbe, writeCapture } from '../src/probe.js'
import { readStream } from '../src/stdin.js'

let dataDir: string
const originalEnv = process.env['PLUGIN_DATA']
const stdoutWrites: string[] = []
const stderrWrites: string[] = []
const originalStdout = process.stdout.write.bind(process.stdout)
const originalStderr = process.stderr.write.bind(process.stderr)

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'jev-probe-'))
  process.env['PLUGIN_DATA'] = dataDir
  stdoutWrites.length = 0
  stderrWrites.length = 0
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutWrites.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrWrites.push(String(chunk))
    return true
  }) as typeof process.stderr.write
})

afterEach(async () => {
  process.stdout.write = originalStdout
  process.stderr.write = originalStderr
  if (originalEnv === undefined) delete process.env['PLUGIN_DATA']
  else process.env['PLUGIN_DATA'] = originalEnv
  await rm(dataDir, { recursive: true, force: true })
})

function stdout(): string {
  return stdoutWrites.join('')
}

describe('readStream', () => {
  it('reads a stream to a string and enforces the cap', async () => {
    const stream = new PassThrough()
    stream.end('hello world')
    expect(await readStream(stream)).toBe('hello world')

    const capped = new PassThrough()
    capped.end('abcdefghij')
    expect(await readStream(capped, 4)).toBe('abcd')
  })
})

describe('probe module', () => {
  it('captures raw stdin payloads to the probe directory', async () => {
    const file = await writeCapture('PreCompact', '{"trigger":"manual"}')
    expect(file).toContain(path.join(dataDir, 'probe'))
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ event: 'PreCompact' })
  })

  it('lists and inspects captured records', async () => {
    await writeCapture('SessionStart', '{"source":"compact"}')
    expect(await runProbe(['ls'])).toBe(0)
    expect(stdout()).toContain('SessionStart')

    stdoutWrites.length = 0
    const file = path.join(dataDir, 'probe', (await readdir(path.join(dataDir, 'probe')))[0] as string)
    expect(await runProbe(['inspect', file])).toBe(0)
    expect(stdout()).toContain('"source": "compact"')
    void stderrWrites
  })

  it('handles missing data gracefully', async () => {
    expect(await runProbe(['ls'])).toBe(0)
    expect(stdout()).toContain('no probe captures yet')
    expect(await runProbe(['bogus'])).toBe(0)
    expect(stderrWrites.join('')).toContain('usage')
  })
})

describe('cli dispatch', () => {
  it('prints usage for help and unknown commands', async () => {
    expect(await main(['--help'])).toBe(0)
    expect(stdout()).toContain('usage:')
    stdoutWrites.length = 0
    expect(await main(['wat'])).toBe(0)
    expect(stderrWrites.join('')).toContain('unknown command: wat')
  })

  it('routes probe subcommands', async () => {
    expect(await main(['probe', 'ls'])).toBe(0)
    expect(stdout()).toContain('no probe captures yet')
  })
})
