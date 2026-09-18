import { accessSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { build } from 'esbuild'

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/fast-jev.mjs',
  sourcemap: false,
  legalComments: 'none',
  minify: false,
  logLevel: 'info',
})

// Fail the build when the plugin manifest references missing files — a dead
// hook reference is otherwise a fully silent failure at runtime.
const manifestPath = path.resolve('.codex-plugin/plugin.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  hooks?: string
  skills?: string
  mcpServers?: string
}
const referenced: string[] = []
if (typeof manifest.hooks === 'string') referenced.push(manifest.hooks)
if (typeof manifest.skills === 'string') referenced.push(manifest.skills)
if (typeof manifest.mcpServers === 'string') referenced.push(manifest.mcpServers)
for (const relative of referenced) {
  try {
    accessSync(path.resolve(relative))
  } catch {
    process.stderr.write(`build: plugin.json references missing path: ${relative}\n`)
    process.exit(1)
  }
}
