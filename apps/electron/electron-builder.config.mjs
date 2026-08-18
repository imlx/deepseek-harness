/**
 * electron-builder configuration for the DeepSeek Harness desktop shell.
 *
 * The app ships two payloads:
 *  - the Electron main/preload entry (`lib/`), packed into the app asar, and
 *  - the flattened dsh runtime (`runtime/`, produced by scripts/collect-runtime.mjs):
 *    every plugin package the main process loads by name at boot, plus the built
 *    web frontend. It ships as loose files (not in the asar) because the loader
 *    resolves packages by their real path and builds symlinks against them.
 *
 * The DMG is unsigned by default; signing is enabled by setting CSC_LINK /
 * CSC_KEY_PASSWORD (and notarization via APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
 * APPLE_TEAM_ID) in the environment — see the packaging notes.
 */

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'com.deepseek.harness',
  productName: 'DeepSeek Harness',
  directories: {
    output: 'release',
  },
  // electron-builder resolves and packs the workspace's own node_modules, which we
  // do not want (the runtime is pre-flattened into runtime/). Restrict the packed
  // app to our entry + assets, and drop the auto-collected dependencies.
  // The flattened runtime travels inside the app. asar is disabled: the dsh loader
  // resolves plugins by real path and heals symlinks against them, which an asar's
  // virtual paths cannot back, and asarUnpack does not honor appDir-relative globs in
  // a pnpm monorepo. Everything ships as plain files under Resources/app/.
  asar: false,
  files: [
    'lib/main.js',
    'lib/preload.js',
    'lib/overlay.patch.yml',
    'package.json',
    'runtime/**',
    '!node_modules/**',
  ],
  // Regenerate the flattened runtime immediately before packing so extraResources
  // always sees a fresh tree regardless of invocation order.
  beforePack: async (context) => {
    const { execFileSync } = await import('node:child_process')
    execFileSync(process.execPath, ['scripts/collect-runtime.mjs', 'runtime'], {
      cwd: context.appDir,
      stdio: 'inherit',
    })
  },
  asarUnpack: [],
  mac: {
    category: 'public.app-category.developer-tools',
    target: ['dmg'],
    // Unsigned local builds; identity is picked up from CSC_LINK when provided.
    identity: null,
  },
  dmg: {
    title: 'DeepSeek Harness',
  },
  // electron-builder must not try to reinstall production deps: the runtime is
  // pre-flattened by collect-runtime.mjs, not resolved from package.json. Disabling
  // the dep install/rebuild keeps pnpm (and its ignored-builds failure) out of packing.
  npmRebuild: false,
  buildDependenciesFromSource: false,
}
