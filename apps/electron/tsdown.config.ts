import { defineConfig } from 'tsdown'

/**
 * The Electron shell ships one entry: the main process referenced by
 * package.json `main`. The root tsdown builds only `lib/types/index.js`, so
 * this override points at `lib/types/main.js`; the graph composer bundles with
 * it. `electron` stays external — it is provided by the runtime that launches
 * the shell. Declarations come from `tsc -b` (dts: false), matching every
 * package.
 */
export default defineConfig({
  entry: ['lib/types/main.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: ['electron'],
})
