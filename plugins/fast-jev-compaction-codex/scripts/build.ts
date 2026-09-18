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
