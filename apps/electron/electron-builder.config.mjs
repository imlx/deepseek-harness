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
 * Signing and notarization are opt-in via the environment. Set DSH_SIGN_IDENTITY to
 * the Developer ID Application certificate's full name (or rely on the default
 * keychain lookup) to sign; set APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
 * APPLE_TEAM_ID (or APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER) to notarize.
 * With neither set the build stays unsigned, which is right for local runs.
 */

const identity = process.env.DSH_SIGN_IDENTITY ?? null
const notarize = process.env.APPLE_TEAM_ID !== undefined || process.env.APPLE_API_KEY !== undefined

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
  // In a pnpm monorepo electron-builder auto-collects the whole workspace into
  // node_modules; the negation drops that so only our explicit entries ship.
  files: [
    'lib/main.js',
    'lib/preload.js',
    'lib/overlay.patch.yml',
    'package.json',
    'runtime/**',
    // The main process's own static imports resolve from app/node_modules (Node ESM
    // walks up from lib/), distinct from the runtime tree the dynamic loader uses.
    // collect-runtime mirrors just those entry packages into appdeps/; map it onto
    // app/node_modules here.
    { from: 'appdeps', to: 'node_modules' },
    '!node_modules/**',
    // Cross-platform native binaries (node-pty's Windows ConPTY, etc.) ship in the
    // package but are not Mach-O, so Apple's notary service rejects the archive.
    // Exclude them from the mac build; they belong to the Windows package.
    '!runtime/**/prebuilds/win32-*/**',
    '!runtime/**/prebuilds/linux-*/**',
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
    icon: 'build/icon.icns',
    identity,
    // Notarize only when the Apple credentials are present; unsigned local builds
    // skip both steps.
    notarize,
    // Hardened runtime + entitlements are required for notarization.
    hardenedRuntime: true,
    gatekeeperAssess: false,
  },
  win: {
    icon: 'build/icon.png',
    target: ['nsis'],
  },
  linux: {
    icon: 'build/icon.png',
    target: ['AppImage'],
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
