import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_CONFIG,
  configPath,
  loadConfig,
  parseConfigJson,
  resolveCodexHome,
  resolveDataDir,
  resolvePluginRoot,
} from '../src/config.js'

let homeDir: string

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), 'jev-config-'))
})

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true })
})

describe('parseConfigJson', () => {
  it('returns defaults for empty or broken files', () => {
    expect(parseConfigJson('')).toEqual(DEFAULT_CONFIG)
    expect(parseConfigJson('not json')).toEqual(DEFAULT_CONFIG)
    expect(parseConfigJson('[1,2]')).toEqual(DEFAULT_CONFIG)
  })

  it('applies provided values and ignores unknown keys', () => {
    const config = parseConfigJson(
      JSON.stringify({
        apiKey: 'k',
        model: 'jev-x',
        keepThreshold: 0.7,
        unknownKey: true,
      }),
    )
    expect(config.apiKey).toBe('k')
    expect(config.model).toBe('jev-x')
    expect(config.keepThreshold).toBe(0.7)
    expect(config.maxBackfillChars).toBe(DEFAULT_CONFIG.maxBackfillChars)
  })

  it('clamps numbers into safe ranges', () => {
    const config = parseConfigJson(
      JSON.stringify({ keepThreshold: 99, maxRequestTokens: 1, jevDeadlineMs: -5, archiveTtlHours: 1e9 }),
    )
    expect(config.keepThreshold).toBe(1)
    expect(config.maxRequestTokens).toBe(2000)
    expect(config.jevDeadlineMs).toBe(1000)
    expect(config.archiveTtlHours).toBe(168)
  })
})

describe('loadConfig', () => {
  it('reads the config file from CODEX_HOME and applies env key override', async () => {
    const file = configPath({ CODEX_HOME: homeDir })
    await writeFile(file, JSON.stringify({ model: 'jev-from-file', apiKey: 'file-key' }))
    const config = await loadConfig({ CODEX_HOME: homeDir, TYPESAFE_API_KEY: 'env-key' })
    expect(config.model).toBe('jev-from-file')
    expect(config.apiKey).toBe('env-key')
  })

  it('falls back to defaults when the file is missing', async () => {
    const config = await loadConfig({ CODEX_HOME: homeDir })
    expect(config).toEqual(DEFAULT_CONFIG)
  })
})

describe('path resolution', () => {
  it('resolveCodexHome honors CODEX_HOME and defaults to ~/.codex', () => {
    expect(resolveCodexHome({ CODEX_HOME: '/x' })).toBe('/x')
    expect(resolveCodexHome({})).toBe(path.join(os.homedir(), '.codex'))
  })

  it('resolveDataDir prefers config.dataDir then PLUGIN_DATA then CODEX_HOME', () => {
    expect(resolveDataDir({ ...DEFAULT_CONFIG, dataDir: '/cfg' }, {})).toBe('/cfg')
    expect(resolveDataDir(DEFAULT_CONFIG, { PLUGIN_DATA: '/pd' })).toBe('/pd')
    expect(resolveDataDir(DEFAULT_CONFIG, { CLAUDE_PLUGIN_DATA: '/cpd' })).toBe('/cpd')
    expect(resolveDataDir(DEFAULT_CONFIG, { CODEX_HOME: '/ch' })).toBe('/ch/fast-jev-compaction-data')
  })

  it('resolvePluginRoot reads plugin root aliases', () => {
    expect(resolvePluginRoot({ PLUGIN_ROOT: '/r' })).toBe('/r')
    expect(resolvePluginRoot({ CLAUDE_PLUGIN_ROOT: '/cr' })).toBe('/cr')
    expect(resolvePluginRoot({})).toBeNull()
  })
})
