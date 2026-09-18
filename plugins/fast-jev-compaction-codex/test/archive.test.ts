import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import {
  archiveDirFor,
  cleanupExpired,
  findLatestArchive,
  markConsumed,
  writeArchive,
} from '../src/archive.js'
import type { DecisionArchive } from '../src/archive.js'

function makeArchive(overrides: Partial<DecisionArchive> = {}): DecisionArchive {
  return {
    version: 1,
    sessionId: 'sess-1',
    trigger: 'manual',
    transcriptPath: '/sessions/rollout-abc.jsonl',
    transcriptBytesAtScore: 1000,
    scoredAt: new Date().toISOString(),
    model: 'jev-latest',
    stateStage: 'full',
    config: { keepThreshold: 0.5, preserveRecentItems: 8 },
    items: [
      {
        callId: 'call_a',
        kind: 'function_call',
        name: 'shell',
        argumentsJson: '{"command":"ls"}',
        outputText: 'file.txt',
        outputChars: 8,
        isError: false,
        callOrdinal: 2,
        resultOrdinal: 3,
        keepCall: 0.9,
        keepResult: 0.1,
        action: 'drop_result',
        pinned: false,
      },
    ],
    ...overrides,
  }
}

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'jev-archive-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe('archive roundtrip', () => {
  it('writes and finds an archive by transcript path', async () => {
    const archive = makeArchive()
    const written = await writeArchive(dataDir, archive)
    const hit = await findLatestArchive(dataDir, 'sess-1', archive.transcriptPath, 2)
    expect(hit?.path).toBe(written)
    expect(hit?.archive.items[0]?.callId).toBe('call_a')
  })

  it('keys directories on the transcript basename', () => {
    expect(archiveDirFor(dataDir, '/sessions/rollout-abc.jsonl')).toBe(
      path.join(dataDir, 'decisions', 'rollout-abc.jsonl'),
    )
  })

  it('falls back to a session_id match across transcript paths', async () => {
    const archive = makeArchive()
    await writeArchive(dataDir, archive)
    const hit = await findLatestArchive(dataDir, 'sess-1', '/sessions/rollout-OTHER.jsonl', 2)
    expect(hit?.archive.sessionId).toBe('sess-1')
  })

  it('ignores archives past the TTL', async () => {
    const stale = makeArchive({ scoredAt: new Date(Date.now() - 5 * 3_600_000).toISOString() })
    await writeArchive(dataDir, stale)
    const hit = await findLatestArchive(dataDir, 'sess-1', stale.transcriptPath, 2)
    expect(hit).toBeNull()
  })

  it('ignores consumed archives', async () => {
    const archive = makeArchive()
    const written = await writeArchive(dataDir, archive)
    await markConsumed(written)
    expect(await readFile(`${written}.consumed`, 'utf8')).toContain('T')
    expect(await findLatestArchive(dataDir, 'sess-1', archive.transcriptPath, 2)).toBeNull()
  })

  it('prefers the freshest of several archives', async () => {
    const older = makeArchive({ scoredAt: new Date(Date.now() - 60_000).toISOString() })
    const newer = makeArchive()
    await writeArchive(dataDir, older)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const newerPath = await writeArchive(dataDir, newer)
    const hit = await findLatestArchive(dataDir, 'sess-1', older.transcriptPath, 2)
    expect(hit?.path).toBe(newerPath)
  })
})

describe('cleanupExpired', () => {
  it('removes expired archives and stale tmp files but keeps fresh ones', async () => {
    const stale = makeArchive({ scoredAt: new Date(Date.now() - 5 * 3_600_000).toISOString() })
    const fresh = makeArchive()
    await writeArchive(dataDir, stale)
    const freshPath = await writeArchive(dataDir, fresh)
    const tmpJunk = path.join(archiveDirFor(dataDir, stale.transcriptPath), 'junk.tmp-123')
    await (await import('node:fs/promises')).writeFile(tmpJunk, 'x')

    await cleanupExpired(dataDir, 2)

    const dir = archiveDirFor(dataDir, stale.transcriptPath)
    const remaining = await readdir(dir)
    expect(remaining.some((name) => name.startsWith('junk.tmp-'))).toBe(false)
    const expiredGone = await readdir(dir).then((names) =>
      names.every((name) => name === path.basename(freshPath) || !name.endsWith('.json')),
    )
    expect(expiredGone).toBe(true)
    await readFile(freshPath, 'utf8')
  })
})
