import { defineConfig } from 'tsup'

export default defineConfig([
  {
    // Edge-safe library entries: no static node:* imports allowed here.
    entry: { index: 'src/index.ts', node: 'src/node.ts' },
    format: ['esm', 'cjs'],
    // tsup's dts worker sets `baseUrl`, which TypeScript 6 rejects as deprecated (see NOTES.md).
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    clean: true,
    target: 'node22',
    platform: 'neutral',
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
  },
])
