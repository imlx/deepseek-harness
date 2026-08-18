/**
 * Electron main process for the minimal IPC-transport validation.
 *
 * Boots a dsh profile in-process (the `web` composition minus every port-binding
 * and browser-graph row, via overlay.patch.yml), exposes the API gateway to the
 * renderer over IPC, and loads a minimal page that drives a conversation end to
 * end. This is the transport proof of concept: no webserver, no client-module
 * graph, no bundled UI roster — just `toFetchHandler(apiProxy)` for unary calls
 * and `apiProxy.events` for the downlink, both carried over IPC.
 *
 * The assembly below mirrors `apps/cli/src/profile-boot.ts`'s runProfile, but
 * builds on the public `@deepseek-ai/dsh-app-boot` API so the Electron shell
 * does not depend on the CLI package's unpublished internals.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { writeFileSync, readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import {
  boot,
  loadLayeredEnv,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  healProfilesModuleFallback,
  PROFILE_PATCH_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId, type ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HostFrame, MuxFrame, RpcRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { composeElectronGraph, injectBootManifest } from './graph.ts'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
/** The dsh installation anchor used to resolve bundle packages (apps/cli's manifest). */
const INSTALL_ANCHOR = require.resolve('@deepseek-ai/dsh/package.json')
/** Repository root (apps/cli → apps → root); loadLayeredEnv reads the root .env here. */
const REPO_ROOT = join(dirname(INSTALL_ANCHOR), '..', '..')
/** Shipped agent-preset root beside the CLI's own config (same source as profile-boot). */
const SHIPPED_PRESET_ROOT = join(dirname(INSTALL_ANCHOR), 'config', 'agent-presets')
/** Static assets live in src/ beside main.ts; the compiled main.js runs from lib/. */
const SRC = join(HERE, '..', 'src')
/** Overlay disabling every port-binding / browser-graph row of the web composition. */
const OVERLAY = join(HERE, '..', 'overlay.patch.yml')
/** The built web frontend index, loaded over file:// after the boot graph is injected. */
const DIST_INDEX = join(REPO_ROOT, 'apps', 'web', 'dist', 'index.html')
/** Preload script installing window.dshIpc. */
const PRELOAD = join(SRC, 'preload.js')
/** Client packages forced into the graph although their host row is disabled (no webserver). */
const FORCED_CLIENT_PACKAGES = ['@deepseek-ai/dsh-client-connection'] as const

const BIN = 'dsh'
/** Empty root config the composed patch list mounts over (same contract as profile-boot). */
const ROOT_CONFIG = '# electron validation root — empty entry list.\n[]\n'

/**
 * Compose the web profile's effective patch stack plus the Electron overlay, then
 * boot it. The host Connection RPC service is provided in the prepare hook so the
 * Typert gateway's `ctx.inject(['connection'])` resolves at mount and registers
 * its Remote interceptor - without it every Remote endpoint (plugin inventory,
 * goals, cordis) would fall through to the unary fallback and 404. Returns the
 * root context, the profile dir (the module-resolution anchor the client-graph
 * composer needs), and the Connection service once the tree has settled.
 * @returns the booted root context, the profile directory, and the Connection service.
 */
async function bootHarness(): Promise<{ ctx: Context; profileDir: string; connection: HostConnectionService }> {
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(BIN, 'web', INSTALL_ANCHOR)
  const rootConfig = join(profile.dir, 'cordis.yml')
  writeFileSync(rootConfig, ROOT_CONFIG)

  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const homePatches = loadOptionalPatches(BIN, join(profile.dir, PROFILE_PATCH_FILENAME)) ?? []
  const overlays = loadOverlayPatches(BIN, OVERLAY)
  // The shipped agent-preset root is an assembly fact only this app can resolve
  // (it sits beside apps/cli's config); without it no preset is found and
  // session.create fails with agent-preset-not-found. A patch replaces the whole
  // config, so restate `default` alongside the shipped root.
  const presetRootPatch = {
    id: 'agent-presets',
    config: { default: 'standard', roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }] },
  }
  const patches = [...bundlePatches, ...profile.patches, ...homePatches, ...overlays, presetRootPatch]

  const environment = loadLayeredEnv(BIN, REPO_ROOT)
  let connection: HostConnectionService | undefined
  const ctx = await boot(BIN, rootConfig, patches, (hostCtx: Context) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    // The overlay disables the connection row (its host half injects webServer),
    // but the shell still needs the host Connection RPC registry: instantiating the
    // service here provides ctx.connection on the root, and its interceptor path
    // never touches a webServer. Only the handle() channel registration would, and
    // the Electron composition routes every /api call through the shell's bridge.
    connection = new HostConnectionService(hostCtx, [])
  })
  if (connection === undefined) throw new Error('electron: HostConnectionService was not created during prepare')
  return { ctx, profileDir: profile.dir, connection }
}

/** Read the composed ApiProxy service, failing loud if the composition dropped it. */
function resolveApiProxy(ctx: Context): ApiProxy {
  const api = ctx.get('apiProxy')
  if (api === undefined) throw new Error('electron: ctx.apiProxy missing after boot — the overlay must not disable api-gateway')
  return api
}

/** One open downlink stream's cancel handle plus the gate that holds its pump. */
interface OpenStream {
  cancel: AbortController
  /** Resolves once the renderer's stream listener is attached (dsh:streamReady). */
  markReady: () => void
  /** Settles when the renderer signals readiness; the pump awaits it before sending. */
  ready: Promise<void>
}

/**
 * Complete a narrow `RpcRequest<frame>` into the full ServerRequest wire form
 * (`method` = the frame's type) — the same envelope `toFetchHandler`'s SSE codec
 * emits, so the renderer's one frame parser serves both carriers.
 */
function fullFrame(narrow: RpcRequest<MuxFrame | HostFrame>): ServerRequest {
  return { type: 'server-request', rpcId: narrow.rpcId, method: narrow.payload.type, payload: narrow.payload }
}

/**
 * Bridge the gateway over IPC. Unary POSTs dispatch through the Connection
 * service's shared-channel handler - the Typert Remote interceptor claims its
 * endpoints first, the unary routes of `toFetchHandler(apiProxy)` answer the
 * rest - the same order the web `/api` route serves. Each downlink stream
 * iterates `apiProxy.events` in-process and pushes frames to the requesting
 * webContents. The `file://` origin means the renderer issues paths under
 * `http://dsh.internal`, which the fetch handler accepts directly.
 * @param api - the composed gateway.
 * @param connection - the host Connection RPC service holding the interceptor registry.
 */
function bridge(api: ApiProxy, connection: HostConnectionService): void {
  const handler = connection.createSharedFetchHandler('/api', toFetchHandler(api))
  const streams = new Map<string, OpenStream>()
  let nextStream = 0

  ipcMain.handle('dsh:fetch', async (_event, path: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const request = new Request(new URL(path, 'http://dsh.internal'), {
      method: init.method ?? 'GET',
      ...(init.headers === undefined ? {} : { headers: init.headers }),
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    const response = await handler.fetch(request)
    return { status: response.status, body: await response.text() }
  })

  ipcMain.handle('dsh:openStream', (event, path: string) => {
    const id = `s${nextStream++}`
    const cancel = new AbortController()
    let markReady: () => void = () => undefined
    const ready = new Promise<void>((resolve) => { markReady = resolve })
    streams.set(id, { cancel, markReady, ready })
    const sender = event.sender
    const iterable = path.endsWith('events.host')
      ? api.events.host({ rpcId: RpcId(crypto.randomUUID()), payload: {} }, cancel.signal)
      : api.events.mux({ rpcId: RpcId(crypto.randomUUID()), payload: {} }, cancel.signal)
    void (async () => {
      try {
        // Hold the pump until the renderer's channel listener is attached: the
        // mux/host streams push their baseline frames at open, and an IPC send to
        // a channel with no listener is silently dropped. Awaiting readiness here
        // keeps the renderer's initial session/task/approval view complete. Bail
        // if the renderer is destroyed before it ever signals ready, so a
        // never-ready stream does not leak.
        await ready
        if (sender.isDestroyed()) return
        for await (const frame of iterable) {
          if (sender.isDestroyed()) break
          // The renderer's readIpcStream parses the full ServerRequest form (the same
          // envelope toFetchHandler's SSE codec emits), so wrap the narrow RpcRequest
          // here: method = the frame's own type.
          sender.send(`dsh:stream:${id}`, JSON.stringify(fullFrame(frame)))
        }
        if (!sender.isDestroyed()) sender.send(`dsh:stream:${id}`, null)
      } catch {
        if (!sender.isDestroyed()) sender.send(`dsh:stream:${id}`, null)
      } finally {
        streams.delete(id)
      }
    })()
    return id
  })

  // The renderer signals its per-stream listener is attached; the pump holds
  // until this arrives so no baseline frame is sent into an unlistened channel.
  ipcMain.on('dsh:streamReady', (_event, id: string) => {
    streams.get(id)?.markReady()
  })

  ipcMain.on('dsh:closeStream', (_event, id: string) => {
    streams.get(id)?.cancel.abort()
    streams.delete(id)
  })
}

async function main(): Promise<void> {
  await app.whenReady()
  const { ctx, profileDir, connection } = await bootHarness()
  bridge(resolveApiProxy(ctx), connection)

  // Compose the client module graph without a webserver and inject it into the
  // built frontend index. The injected copy lives beside index.html so its
  // relative asset refs (./assets/…) keep resolving against the dist directory.
  const graph = composeElectronGraph(ctx, profileDir, FORCED_CLIENT_PACKAGES)
  const html = injectBootManifest(readFileSync(DIST_INDEX, 'utf8'), graph)
  const electronIndex = join(dirname(DIST_INDEX), 'index.electron.html')
  writeFileSync(electronIndex, html)

  // Dispose the composed tree before quitting: every plugin's effects unwind
  // (fibers, watchers, open downlink streams) rather than leaking past exit.
  app.on('window-all-closed', () => {
    void ctx.fiber.dispose().finally(() => { app.quit() })
  })

  const win = new BrowserWindow({
    width: 960,
    height: 720,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  })
  await win.loadFile(electronIndex)
}

void main()
