import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { DesktopNotification, DesktopNotificationSink } from '../src/types.ts'
import * as plugin from '../src/index.ts'
import { DesktopNotificationSettingsSchema } from '../src/index.ts'

/** A recording sink: captures notifications, controllable focus and locale. */
function fakeSink(overrides: Partial<DesktopNotificationSink> = {}): DesktopNotificationSink & { sent: DesktopNotification[] } {
  const sent: DesktopNotification[] = []
  return {
    sent,
    locale: 'en',
    isFocused: () => false,
    focus: vi.fn(),
    notify: (n) => { sent.push(n) },
    ...overrides,
  }
}

/** Mount the Consumer with a real SessionStore plus the fake sink/settings/jobs. */
async function mounted(
  sink: DesktopNotificationSink,
  settings?: Record<string, boolean>,
): Promise<{ ctx: Context; fireJob: (s: JobSnapshot) => void }> {
  const ctx = new Context()
  ctx.provide('desktopNotifications', sink)
  // A minimal settings provider: register returns a live scope over the schema
  // defaults overlaid with the test's overrides (mirrors the real provider,
  // which resolves the schema before serving get()).
  const value = DesktopNotificationSettingsSchema({ ...(settings ?? {}) } as never)
  ctx.provide('settings', {
    register: (_ns: unknown, _schema: unknown, _opts?: unknown) => ({
      get: () => value,
      watch: () => () => {},
      update: () => Promise.resolve(),
      replace: () => Promise.resolve(),
    }),
  })
  const jobListeners: Array<(s: JobSnapshot) => void> = []
  ctx.provide('jobs', {
    onJobDone: (l: (s: JobSnapshot) => void) => {
      jobListeners.push(l)
      return () => {}
    },
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(plugin)
  const fireJob = (s: JobSnapshot): void => {
    for (const l of jobListeners) l(s)
  }
  return { ctx, fireJob }
}

/** Drive one user-initiated turn to completion on a fresh session. */
function runUserTurn(ctx: Context, id: string, reason: 'completed' | 'error'): void {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append(
    'user/message',
    { source: { kind: 'user' }, content: 'hi' } as unknown as SessionEvent<'user/message'>['data'],
    { surfaceOp: 'append' },
  )
  // TurnEndReason is a discriminated union: the error variant carries a failure
  // payload, so narrow the reason before appending rather than casting.
  const turnEndReason: SessionEvent<'turn/end'>['data']['reason'] = reason === 'completed'
    ? { kind: 'completed' }
    : { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } }
  session.append('turn/end', { turn: 1, reason: turnEndReason })
}

describe('desktop-notifications Consumer', () => {
  it('notifies when a user-initiated turn completes', async () => {
    const sink = fakeSink()
    const { ctx } = await mounted(sink)
    runUserTurn(ctx, 's-complete', 'completed')
    expect(sink.sent).toEqual([{ title: 'Turn completed', body: 'A turn you started has finished.' }])
  })

  it('notifies with failure copy when a user turn ends in error', async () => {
    const sink = fakeSink()
    const { ctx } = await mounted(sink)
    runUserTurn(ctx, 's-error', 'error')
    expect(sink.sent).toEqual([{ title: 'Turn needs attention', body: 'A turn you started ended with an error.' }])
  })

  it('renders Chinese copy when the sink locale is zh', async () => {
    const sink = fakeSink({ locale: 'zh' })
    const { ctx } = await mounted(sink)
    runUserTurn(ctx, 's-zh', 'completed')
    expect(sink.sent).toEqual([{ title: '回合已完成', body: '你发起的一个回合已结束。' }])
  })

  it('skips subagent sessions entirely', async () => {
    const sink = fakeSink()
    const { ctx } = await mounted(sink)
    const session = ctx.sessions.create(SessionId('s-sub'), { meta: { origin: 'subagent' } })
    session.append('turn/start', { turn: 1 })
    session.append(
      'user/message',
      { source: { kind: 'user' }, content: 'x' } as unknown as SessionEvent<'user/message'>['data'],
      { surfaceOp: 'append' },
    )
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(sink.sent).toEqual([])
  })

  it('skips a turn the user did not initiate (no user/message)', async () => {
    const sink = fakeSink()
    const { ctx } = await mounted(sink)
    const session = ctx.sessions.create(SessionId('s-auto'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(sink.sent).toEqual([])
  })

  it('notifies on job completion and failure', async () => {
    const sink = fakeSink()
    const { fireJob } = await mounted(sink)
    fireJob({ status: 'completed' } as JobSnapshot)
    fireJob({ status: 'failed' } as JobSnapshot)
    expect(sink.sent).toEqual([
      { title: 'Background job completed', body: 'A background job has finished.' },
      { title: 'Background job failed', body: 'A background job needs attention.' },
    ])
  })

  it('always notifies on approval/asked, even when focused', async () => {
    const sink = fakeSink({ isFocused: () => true })
    const { ctx } = await mounted(sink)
    const session = ctx.sessions.create(SessionId('s-approval'))
    session.append('turn/start', { turn: 1 })
    session.append('approval/asked', { id: 'a1', toolName: 'bash' } as unknown as SessionEvent<'approval/asked'>['data'])
    expect(sink.sent).toEqual([{ title: 'Approval needed', body: 'A tool call is waiting for your decision.' }])
  })

  it('suppresses completion banners while focused but not approval requests', async () => {
    const sink = fakeSink({ isFocused: () => true })
    const { ctx } = await mounted(sink)
    runUserTurn(ctx, 's-focused', 'completed')
    expect(sink.sent).toEqual([])
  })

  it('honors the per-kind settings gates', async () => {
    const sink = fakeSink()
    const { ctx } = await mounted(sink, { notifyOnTurnCompletion: false, silentWhenFocused: false })
    runUserTurn(ctx, 's-gated', 'completed')
    expect(sink.sent).toEqual([])
  })

  it('no-ops when no sink is provided (web/headless composition)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(plugin)
    const session = ctx.sessions.create(SessionId('s-nosink'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // No assertion on a sink — the point is that nothing throws.
    expect(true).toBe(true)
  })
})
