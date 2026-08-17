/** Electron API carrier: IPC-invoke upstream plus one IPC push channel per downstream event stream. */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from './api.ts'
import { AbstractApiClient } from './api.ts'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { RpcId, serverResponseSchema, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientConnectionRpc } from '../rpc.ts'
import { randomUuid } from './random-uuid.ts'

/** Serializable fetch-init subset that survives the structured-clone IPC boundary. */
export interface IpcFetchInit {
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
}

/** The preload-exposed bridge this client drives; owned by the Electron shell's preload. */
export interface DshIpcBridge {
  /**
   * Unary/one-shot carrier: forwards `(path, init)` to the main process's
   * `toFetchHandler(apiProxy).fetch` and resolves with the wire response.
   * @param path - request path under the internal base, e.g. `/api/session.list`.
   * @param init - serializable fetch init (method, headers, string body).
   * @returns the status plus raw body text; downstream streams use {@link openStream}.
   */
  fetch(path: string, init: IpcFetchInit): Promise<{ status: number; body: string }>
  /**
   * Open a downstream event stream: the main process subscribes the matching
   * `apiProxy.events` channel and pushes each raw SSE `data:` payload back.
   * @param path - `/api/events.mux` or `/api/events.host`.
   * @returns the opened stream id used by {@link onStream} and {@link closeStream}.
   */
  openStream(path: string): Promise<string>
  /**
   * Subscribe to one open stream's pushed frames.
   * @param streamId - id from {@link openStream}.
   * @param listener - receives each raw frame string, or `null` on stream end.
   * @returns unsubscribe function.
   */
  onStream(streamId: string, listener: (data: string | null) => void): () => void
  /** Abandon one open stream (renderer-driven cancel). */
  closeStream(streamId: string): void
}

declare global {
  interface Window {
    dshIpc?: DshIpcBridge
  }
}

/** True when the running page is the Electron renderer (its preload installed the bridge). */
export function isElectronBridge(): boolean {
  return (globalThis as { dshIpc?: DshIpcBridge }).dshIpc !== undefined
}

/** Resolve the bridge, failing loud when the preload did not install it (wrong surface). */
function bridge(): DshIpcBridge {
  const ipc = (globalThis as { dshIpc?: DshIpcBridge }).dshIpc
  if (ipc === undefined) throw new Error('client-connection: window.dshIpc is missing — the Electron preload did not install the bridge')
  return ipc
}

/**
 * Electron platform subclass: unary/respond ride {@link DshIpcBridge.fetch};
 * mux/host override to IPC push streams (mirroring `WebApiClient`'s WebSocket
 * override — the architecture deliberately lets each platform supply its own
 * downstream channel). Unlike `WebApiClient` there is no HTTP authority or
 * browser trust fence: the main process is the same application, and
 * `resolveBase()` collapses the `file://` origin to `http://dsh.internal`, so
 * every path is well-formed before it crosses IPC.
 */
export class ElectronApiClient extends AbstractApiClient {
  private readonly ipc = bridge()

  protected async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const signal = init?.signal ?? undefined
    if (signal?.aborted === true) return Promise.reject(abortError(signal))
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value })
    const body = typeof init?.body === 'string' ? init.body : undefined
    const pending = this.ipc.fetch(input.pathname, {
      ...(init?.method === undefined ? {} : { method: init.method }),
      headers,
      ...(body === undefined ? {} : { body }),
    })
    const raced = signal === undefined
      ? pending
      : new Promise<{ status: number; body: string }>((resolve, reject) => {
        const onAbort = (): void => { reject(abortError(signal)) }
        signal.addEventListener('abort', onAbort, { once: true })
        pending.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
      })
    const { status, body: text } = await raced
    return new Response(text, { status })
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readIpcStream('/api/events.mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readIpcStream('/api/events.host', signal, hostFrameSchema, onOpen)
  }

  /**
   * IPC downstream path: mirrors `WebApiClient.readWebSocket` — an inbox/wake
   * generator fed by pushed frames. The main process has already parsed SSE
   * framing, so each pushed item is one `data:` payload; this layer applies
   * the same envelope + frame-schema parse the SSE/WebSocket paths apply, so
   * one corrupt frame is dropped, never fatal.
   */
  private async *readIpcStream<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: { parse(value: unknown): F },
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    type Item = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }
    const inbox: Item[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: Item): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const streamId = await this.ipc.openStream(path)
    const unsubscribe = this.ipc.onStream(streamId, (data) => {
      if (data === null) {
        enqueue({ kind: 'end' })
        return
      }
      let full: ServerRequest
      let frame: F
      try {
        full = serverRequestSchema.parse(JSON.parse(data))
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed IPC frame on ${path}:`, error)
        return
      }
      this.onEnvelope(full)
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
    })
    onOpen?.()
    const handleAbort = (): void => { enqueue({ kind: 'end' }) }
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as Item
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      unsubscribe()
      this.ipc.closeStream(streamId)
    }
  }
}

/** Mirror fetch's abort rejection (same shape as the sibling carriers). */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  if (typeof reason === 'string') return new Error(reason)
  return new Error('This operation was aborted')
}

const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Electron caller for generic Connection unary RPC channels: identical wire
 * contract to `createWebConnectionRpc`, but the request rides the IPC bridge
 * instead of the browser fetch. Shares the channel/endpoint validation so both
 * carriers reject the same malformed targets.
 * @returns caller that owns request correlation and response-envelope validation.
 */
export function createElectronConnectionRpc(): ClientConnectionRpc {
  const ipc = bridge()
  return {
    async call(channel, endpoint, payload, signal) {
      if (!CHANNEL_PATTERN.test(channel)
        || endpoint.split('/').some(segment =>
          segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
        throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
      }
      const rpcId = RpcId(randomUuid())
      const message: ClientRequest = { type: 'client-request', rpcId, method: endpoint, payload }
      if (signal?.aborted === true) throw abortError(signal)
      const pending = ipc.fetch(`${channel}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      })
      // Renderer-side abort race: an IPC invoke cannot be cancelled mid-flight, but a
      // caller abort must still reject rather than resolve with a stale response.
      const { status, body } = signal === undefined
        ? await pending
        : await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const onAbort = (): void => { reject(abortError(signal)) }
          signal.addEventListener('abort', onAbort, { once: true })
          pending.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
        })
      if (status < 200 || status >= 300) {
        throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${status}`)
      }
      const full = serverResponseSchema.parse(JSON.parse(body))
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result
    },
  }
}
