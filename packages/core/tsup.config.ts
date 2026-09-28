import { defineConfig } from 'tsup'

// tsup's dts worker sets `baseUrl`, which TypeScript 6 rejects as deprecated (see NOTES.md).
const dts = { compilerOptions: { ignoreDeprecations: '6.0' } }

export default defineConfig([
  {
    // Edge-safe: no static node:* imports may reach this entry.
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts,
    target: 'node22',
    platform: 'neutral',
  },
  {
    entry: { node: 'src/node.ts' },
    format: ['esm', 'cjs'],
    dts,
    target: 'node22',
    platform: 'node',
  },
  {
    entry: { cli: 'src/bin.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
  },
])
