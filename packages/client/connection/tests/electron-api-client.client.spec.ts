/**
 * ElectronApiClient: the IPC carrier for the Electron renderer. Mocks the
 * preload-installed `window.dshIpc` bridge (no real Electron) and asserts the
 * unary fetch hop, the IPC downlink framing contract, abort/cancel semantics,
 * and the generic-RPC caller — the same surface WebApiClient's specs cover for
 * the browser carrier.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type ConnectionHandle } from '../src/client/index.ts'
import { ElectronApiClient, type DshIpcBridge, type IpcFetchInit } from '../src/client/electron-api-client.ts'
import { WebApiClient } from '../src/client/web-api-client.ts'
import { FixtureApiClient } from '../src/client/fixture.ts'
import type { RpcMessage } from '../src/client/api.ts'

type Win = { location?: { hostname: string; search: string; origin?: string } }

/** A scripted dshIpc bridge: records fetches, drives open streams by hand. */
class FakeIpc implements DshIpcBridge {
  readonly fetches: Array<{ path: string; init: IpcFetchInit }> = []
  readonly opened: string[] = []
  readonly closed: string[] = []
  private readonly listeners = new Map<string, Array<(data: string | null) => void>>()
  private nextId = 0
  /** Queued fetch responses, one per call; defaults to a 404-ish empty body. */
  fetchResponses: Array<{ status: number; body: string }> = []

  fetch(path: string, init: IpcFetchInit): Promise<{ status: number; body: string }> {
    this.fetches.push({ path, init })
    const response = this.fetchResponses.shift() ?? { status: 200, body: '{}' }
    return Promise.resolve(response)
  }

  openStream(path: string): Promise<string> {
    this.opened.push(path)
    const id = `fake-${this.nextId++}`
    this.listeners.set(id, [])
    return Promise.resolve(id)
  }

  onStream(streamId: string, listener: (data: string | null) => void): () => void {
    const list = this.listeners.get(streamId)
    list?.push(listener)
    return () => {
      const current = this.listeners.get(streamId)
      if (current === undefined) return
      const index = current.indexOf(listener)
      if (index !== -1) current.splice(index, 1)
    }
  }

  closeStream(streamId: string): void {
    this.closed.push(streamId)
  }

  /** Push one raw frame string (or null for end) to every listener of a stream. */
  push(streamIndex: number, data: string | null): void {
    const id = `fake-${streamIndex}`
    for (const listener of this.listeners.get(id) ?? []) listener(data)
  }
}

const originalDshIpc = (globalThis as { dshIpc?: DshIpcBridge }).dshIpc
let ipc: FakeIpc

afterEach(() => {
  delete (globalThis as Win).location
  if (originalDshIpc === undefined) delete (globalThis as { dshIpc?: DshIpcBridge }).dshIpc
  else (globalThis as { dshIpc?: DshIpcBridge }).dshIpc = originalDshIpc
})

/** Mount the connection plugin with the Electron bridge installed and a loopback page. */
async function mount(): Promise<ConnectionHandle> {
  ;(globalThis as Win).location = { hostname: 'localhost', search: '', origin: 'null' }
  ;(globalThis as { dshIpc?: DshIpcBridge }).dshIpc = ipc
  const ctx = new Context()
  await ctx.plugin({ apply, inject: [] })
  const handle = ctx.get('connection') as ConnectionHandle | undefined
  if (handle === undefined) throw new Error('ctx.connection not provided')
  return handle
}

/** Wrap a MuxFrame/HostFrame into the full ServerRequest envelope the bridge carries. */
function serverRequest(rpcId: string, frame: { type: string }): string {
  return JSON.stringify({ type: 'server-request', rpcId, method: frame.type, payload: frame })
}

describe('ElectronApiClient', () => {
  it('apply selects the Electron carrier when window.dshIpc is present (and web/fixture otherwise)', async () => {
    ipc = new FakeIpc()
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    ;(globalThis as { dshIpc?: DshIpcBridge }).dshIpc = ipc
    let ctx = new Context()
    await ctx.plugin({ apply, inject: [] })
    expect((ctx.get('connection') as ConnectionHandle).api).toBeInstanceOf(ElectronApiClient)

    // The fixture query still wins over the bridge (test pages keep precedence).
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    ctx = new Context()
    await ctx.plugin({ apply, inject: [] })
    expect((ctx.get('connection') as ConnectionHandle).api).toBeInstanceOf(FixtureApiClient)

    // No bridge at all falls back to the browser carrier.
    delete (globalThis as { dshIpc?: DshIpcBridge }).dshIpc
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    ctx = new Context()
    await ctx.plugin({ apply, inject: [] })
    expect((ctx.get('connection') as ConnectionHandle).api).toBeInstanceOf(WebApiClient)
  })

  it('rides unary calls and respond over dshIpc.fetch, never globalThis.fetch', async () => {
    ipc = new FakeIpc()
    const handle = await mount()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const client = handle.api as ElectronApiClient
    // Schema rejection downstream is fine — the transport hop is the assertion.
    await client.host.describe({}).catch(() => undefined)
    await client.sessions.list({}).catch(() => undefined)
    expect(ipc.fetches.map(call => call.path)).toEqual(['/api/host.describe', '/api/session.list'])
    expect(ipc.fetches.every(call => call.init.method === 'POST')).toBe(true)
    expect(ipc.fetches.every(call => call.init.headers?.['content-type'] === 'application/json')).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('rejects an in-flight unary call when its signal aborts', async () => {
    ipc = new FakeIpc()
    // Never resolving: the abort race, not the response, must settle the call.
    ipc.fetch = () => new Promise(() => undefined)
    const handle = await mount()
    const abort = new AbortController()
    const pending = (handle.api as ElectronApiClient).host.describe({}, abort.signal)
    const assertion = expect(pending).rejects.toThrow(/aborted/i)
    abort.abort()
    await assertion
  })

  it('opens one IPC stream per downlink, parses full frames, drops malformed ones, and ends cleanly', async () => {
    ipc = new FakeIpc()
    const handle = await mount()
    const client = handle.api as ElectronApiClient
    const envelopes: RpcMessage[][] = []
    client.subscribeEnvelopes((batch) => { envelopes.push([...batch]) })
    const opened: string[] = []
    const mux = client.events.mux({}, new AbortController().signal, () => { opened.push('mux') })[Symbol.asyncIterator]()
    const first = mux.next()
    await vi.waitFor(() => { expect(ipc.opened).toEqual(['/api/events.mux']) })
    await vi.waitFor(() => { expect(opened).toEqual(['mux']) })

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // A malformed frame is dropped (logged), never fatal; a valid one is yielded.
    ipc.push(0, 'not-json')
    ipc.push(0, serverRequest('mux-1', { type: 'session/subscribed', sessionId: 'session-e', lastSeq: 4 }))
    expect(await first).toMatchObject({
      value: { rpcId: 'mux-1', payload: { type: 'session/subscribed', lastSeq: 4 } },
    })
    expect(errors).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => { expect(envelopes.flat().length).toBeGreaterThan(0) })

    // End-of-stream (null) completes the generator.
    const end = mux.next()
    ipc.push(0, null)
    await expect(end).resolves.toMatchObject({ done: true })
    expect(ipc.closed).toEqual(['fake-0'])
    errors.mockRestore()
  })

  it('aborts an open stream when its signal fires', async () => {
    ipc = new FakeIpc()
    const handle = await mount()
    const client = handle.api as ElectronApiClient
    const abort = new AbortController()
    const host = client.events.host({}, abort.signal)[Symbol.asyncIterator]()
    const pending = host.next()
    await vi.waitFor(() => { expect(ipc.opened).toEqual(['/api/events.host']) })
    abort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
    expect(ipc.closed).toEqual(['fake-0'])
  })

  it('carries generic RPC over dshIpc with correlation and target validation', async () => {
    ipc = new FakeIpc()
    const handle = await mount()
    ipc.fetchResponses.push({
      status: 200,
      body: JSON.stringify({
        type: 'server-response',
        // Echo whatever rpcId the request carried: capture it from the recorded call.
        rpcId: '',
        result: { ok: true, value: { ref: 'goal-1' } },
      }),
    })
    ipc.fetch = (path, init) => {
      ipc.fetches.push({ path, init })
      const body = JSON.parse(init.body ?? '{}') as { rpcId: string }
      return Promise.resolve({
        status: 200,
        body: JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { ref: 'goal-1' } } }),
      })
    }
    await expect(handle.rpc.call('/api', 'goals/create', { args: { agentId: 'agent-1' } }))
      .resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    expect(ipc.fetches[0]?.path).toBe('/api/goals/create')

    // Transport failure and malformed targets reject, same contract as the web caller.
    ipc.fetch = () => Promise.resolve({ status: 503, body: 'unavailable' })
    await expect(handle.rpc.call('/api', 'goals/create', {})).rejects.toThrow('HTTP 503')
    for (const [channel, endpoint] of [['api2', 'goals/create'], ['/api', '..'], ['/api', 'goals//create']] as const) {
      await expect(handle.rpc.call(channel, endpoint, {})).rejects.toThrow('invalid RPC target')
    }
  })
})
