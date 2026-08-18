/**
 * Collect the Electron app's runtime into a flat, distributable directory.
 *
 * The dsh main process loads its plugin packages by name at boot (`healProfilesModuleFallback`
 * symlinks each one into the profile's module fallback), so they must ship as real files
 * inside the .app — they cannot be bundled into one main.js. pnpm stores them as symlinks
 * into a global store, which a packaged app cannot resolve, so this script walks the
 * dependency closure from the app's install anchor, resolves every package's real location,
 * and copies each into `runtime/node_modules/<name>` with the links flattened.
 *
 * What gets copied per package mirrors its published payload (`files` field, falling back
 * to lib/ + package.json + any referenced config/assets), so the runtime tree carries the
 * built artifacts, not sources.
 *
 * Usage: node scripts/collect-runtime.mjs <outDir>
 * Idempotent: <outDir> is removed and rebuilt each run.
 */
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(HERE, '..') // apps/electron
const outDir = process.argv[2]
if (outDir === undefined) {
  console.error('usage: node scripts/collect-runtime.mjs <outDir>')
  process.exit(1)
}

const require = createRequire(join(APP_DIR, 'package.json'))

/** Resolve a package to its real (symlink-free) directory, or undefined if uninstalled. */
function realPackageDir(spec, fromDir) {
  const anchor = join(fromDir, 'package.json')
  const req = createRequire(anchor)
  // Prefer the manifest directly — internal dsh/cordis packages export ./package.json and
  // their main entry is a TypeScript path a plain createRequire cannot load.
  try {
    return dirname(realpathSync(req.resolve(`${spec}/package.json`)))
  } catch {
    // No exported package.json. External packages that withhold it (chokidar) or are
    // pure-ESM (pi-ai) defeat both require.resolve and a reliable parent-scoped
    // import.meta.resolve, so walk the node_modules chain from the importer upward —
    // the same nearest-wins order Node uses — and take the first manifest that exists.
  }
  for (let dir = fromDir; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', spec)
    if (existsSync(join(candidate, 'package.json'))) {
      return dirname(realpathSync(join(candidate, 'package.json')))
    }
  }
  return undefined
}

/** Read and parse a package.json, or undefined on failure. */
function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** The dependency names a manifest declares (deps + peers + optionals; optionals carry the platform native binaries sharp/koffi load at runtime). */
function declaredDeps(manifest) {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]
}

/**
 * Copy one package's runtime payload into the output tree.
 * Every package copies its whole real directory: dsh `files` fields carry globs
 * (`lib/types/**`) that are fiddly to expand safely, and external packages keep entry
 * points at their root. Skipping sources/tests/docs keeps the tree lean; correctness
 * beats a minimal footprint here — the loader resolves by real path, and a missing
 * artifact fails the whole boot loud.
 */
function copyPackage(realDir, destDir, name) {
  if (readManifest(realDir) === undefined) return
  mkdirSync(dirname(destDir), { recursive: true })
  // Internal dsh/cordis packages keep sources out (their src/ is TypeScript); external
  // npm packages ship runtime code under src/ too (koffi's index.cjs requires src/koffi),
  // so for them only the dependency links are dead weight.
  const internal = name.startsWith('@deepseek-ai/')
  const skip = internal ? ['node_modules', 'src', 'tests', 'docs', '.git', 'coverage', '.turbo'] : ['node_modules']
  cpSync(realDir, destDir, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const top = src.slice(realDir.length).replace(/^[/\\]+/, '').split(/[/\\]/)[0]
      return !skip.includes(top)
    },
  })
}

// Walk the closure from the app's direct dependencies. The install anchor for the dsh
// profile is @deepseek-ai/dsh (apps/cli); the Electron app also needs its own direct deps.
const ROOTS = ['@deepseek-ai/dsh']
const visited = new Map() // name -> realDir

rmSync(outDir, { recursive: true, force: true })
const modulesOut = join(outDir, 'node_modules')
mkdirSync(modulesOut, { recursive: true })

const queue = ROOTS.map(name => ({ name, fromDir: APP_DIR }))
let copied = 0
for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
  if (visited.has(item.name)) continue
  const realDir = realPackageDir(item.name, item.fromDir)
  if (realDir === undefined) continue // declared-but-uninstalled: not a loadable plugin
  visited.set(item.name, realDir)
  const destDir = join(modulesOut, item.name)
  copyPackage(realDir, destDir, item.name)
  copied += 1
  const manifest = readManifest(realDir)
  if (manifest === undefined) continue
  for (const dep of declaredDeps(manifest)) queue.push({ name: dep, fromDir: realDir })
}

console.log(`collect-runtime: copied ${copied} packages into ${relative(process.cwd(), outDir)}`)

// Stage the static assets the packaged main.js loads from beside itself: the preload
// bridge and the composition overlay. Dev resolves them from src/; the packaged app
// has no src/, so they are copied next to lib/main.js here.
const LIB = join(APP_DIR, 'lib')
cpSync(join(APP_DIR, 'src', 'preload.js'), join(LIB, 'preload.js'))
cpSync(join(APP_DIR, 'overlay.patch.yml'), join(LIB, 'overlay.patch.yml'))
console.log('collect-runtime: staged preload.js and overlay.patch.yml into lib/')
