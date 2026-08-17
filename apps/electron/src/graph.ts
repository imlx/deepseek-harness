/**
 * Electron client-module graph composition — the webServer-free counterpart of
 * `ClientModuleRegistry`'s scan/compose. The registry's composition logic is
 * package-private and its class hard-injects `webServer`, so the Electron shell
 * recomposes the same `WebBootGraph` here from each package's `dsh.client`
 * declaration, resolving bundles through the profile's module anchor. The
 * composed graph is injected into the dist index.html by `injectBootManifest`
 * (the one pure export the modules package shares), and the preload's custom
 * `loadBundle` maps each `/plugins/<id>/client.js` URL onto the absolute
 * `file://` bundle path from {@link composeElectronGraph}'s `bundlePaths`.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { injectBootManifest } from '@deepseek-ai/dsh-client-modules'
import type { WebBootEntry, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'

/** sha1 content hash shortened to 12 hex chars (matches the web registry's rev). */
function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/** One resolved client package: its boot row plus the absolute bundle path. */
interface ResolvedClient {
  entry: WebBootEntry
  clientPath: string
}

/**
 * The composed client graph plus the id → absolute-bundle-path table the preload
 * needs to resolve `/plugins/<id>/client.js` URLs onto `file://` paths.
 */
export interface ElectronClientGraph {
  graph: WebBootGraph
  /** id → absolute path of the built `client.js` bundle. */
  bundlePaths: ReadonlyMap<string, string>
}

/**
 * Read one package's `dsh.client` declaration and `./client` export into a boot
 * row. Mirrors the web registry's per-package narrowing: a package without a
 * web `dsh.client` declaration or a built `./client` bundle contributes no row,
 * and a malformed declaration fails the scan loud.
 * @param resolvePkgJson - resolves `<pkg>/package.json` to an absolute path.
 * @param pkgName - the candidate package (a loader entry name).
 * @returns the resolved row, or undefined when the package is not a web client plugin.
 */
function resolveClient(resolvePkgJson: (spec: string) => string, pkgName: string): ResolvedClient | undefined {
  let pkgPath: string
  try {
    pkgPath = resolvePkgJson(`${pkgName}/package.json`)
  } catch {
    // Not a resolvable package root (loader builtins, subpath rows): not a client row.
    return undefined
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dsh?: { client?: { platform?: unknown; inject?: unknown; immediately?: unknown } }
    exports?: Record<string, unknown>
  }
  const decl = pkg.dsh?.client
  if (decl === undefined || decl.platform !== 'web') return undefined
  const clientExport = pkg.exports?.['./client']
  const clientRel = typeof clientExport === 'string'
    ? clientExport
    : (clientExport as { default?: unknown } | undefined)?.default
  if (typeof clientRel !== 'string') {
    throw new Error(`electron graph: ${pkgName} declares dsh.client but exports no "./client" bundle`)
  }
  const clientPath = join(dirname(pkgPath), clientRel)
  const rev = shortHash(readFileSync(clientPath))
  const inject = Array.isArray(decl.inject) ? decl.inject.filter((edge): edge is string => typeof edge === 'string') : undefined
  // The row URL is the bundle's absolute file:// path, not the webserver's
  // /plugins/<id>/client.js route: over file:// the module system's
  // defaultLoadBundle (<script src>) loads it directly, so no custom loadBundle
  // or Electron-specific frontend entry is needed (probed: a file:// page
  // executes an injected classic file:// script and registers its factory).
  const entry: WebBootEntry = {
    id: pkgName,
    url: `file://${clientPath}?rev=${rev}`,
    rev,
    ...(inject !== undefined ? { inject } : {}),
    ...(decl.immediately === true ? { immediately: true } : {}),
  }
  return { entry, clientPath }
}

/**
 * Compose the Electron client graph: scan the booted tree's active loader
 * entries for web `dsh.client` packages, then append any `extraClientPackages`
 * whose host row the overlay disabled (the connection client half must reach
 * the renderer even though its host half is disabled for want of a webserver).
 * @param ctx - the booted root context (its loader entries are the scan source).
 * @param profileDir - the profile directory used as the module-resolution anchor.
 * @param extraClientPackages - client packages to force into the graph (e.g. connection).
 * @returns the composed graph plus the bundle-path table for the preload.
 */
export function composeElectronGraph(
  ctx: Context,
  profileDir: string,
  extraClientPackages: readonly string[],
): ElectronClientGraph {
  const require = createRequire(join(profileDir, 'package.json'))
  const resolvePkgJson = (spec: string): string => require.resolve(spec)

  const names = new Set<string>()
  for (const entry of ctx.loader.entries()) {
    if (entry.fiber !== undefined && !entry.disabled) names.add(entry.options.name)
  }
  for (const extra of extraClientPackages) names.add(extra)

  const entries: WebBootEntry[] = []
  const bundlePaths = new Map<string, string>()
  for (const name of names) {
    const resolved = resolveClient(resolvePkgJson, name)
    if (resolved === undefined) continue
    entries.push(resolved.entry)
    bundlePaths.set(name, resolved.clientPath)
  }
  return { graph: { rev: shortHash(JSON.stringify(entries)), entries }, bundlePaths }
}

export { injectBootManifest }
