/**
 * Desktop-notification capability seam: the Service Definition (the
 * {@link DesktopNotificationSink} contract a shell provides), the settings
 * schema, and the event-driven Consumer plugin.
 *
 * The Consumer subscribes the authoritative in-process `session/event` stream
 * and the jobs registry — never the network downlink — so it observes the same
 * commit points the session log records. It raises a native notification only
 * for events a human should act on: a user-initiated turn closing, a background
 * job settling, or a tool call waiting on an approval decision. Subagent turns
 * and non-user-initiated turns are skipped so a busy parent does not re-signal
 * its own delegation. Approval requests always notify (they block work); turn
 * and job completion banners honor the focus-silence gate.
 *
 * Question-asked notifications are intentionally not wired here: questions do
 * not flow through `session/event`, they go through `ctx.userQuestions.ask()`.
 * That wiring is deferred — see the package README's Known Limitations.
 * @module @deepseek-ai/dsh-desktop-notifications
 */

import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
// Type-only: importing user-approval merges `approval/asked`/`approval/decided`
// into `SessionEventMap`, so `event.type === 'approval/asked'` narrows a
// SessionEvent instead of erroring on a disjoint union.
import type {} from '@deepseek-ai/dsh-user-approval'
import type {
  DesktopNotification,
  DesktopNotificationKind,
  DesktopNotificationLocale,
  DesktopNotificationSettings,
  DesktopNotificationSink,
} from './types.ts'

export type {
  DesktopNotification,
  DesktopNotificationKind,
  DesktopNotificationLocale,
  DesktopNotificationSettings,
  DesktopNotificationSink,
} from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-notifications'

/** Settings namespace shared by the native shell and any future settings UI. */
export const DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE = settingsNamespace('dsh-desktop-notifications')

/** The services the Consumer composes; the sink itself is probed, not required. */
export const inject = ['settings', 'jobs'] as const

/**
 * Context slot the desktop shell fills with its notification adapter before the
 * config tree mounts. Optional: the web/headless compositions provide none, and
 * the Consumer no-ops there. This is the launch-environment pattern — an
 * optional named slot read with `ctx.get`, not a required Service injection.
 */
export const DESKTOP_NOTIFICATIONS_KEY = 'desktopNotifications'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Desktop notification surface; absent outside the Electron desktop shell. */
    desktopNotifications?: DesktopNotificationSink
  }
}

/** Schema for {@link DesktopNotificationSettings}; every gate defaults on. */
export const DesktopNotificationSettingsSchema: z<DesktopNotificationSettings> = z.object({
  notifyOnTurnCompletion: z.boolean().default(true),
  notifyOnTurnFailure: z.boolean().default(true),
  notifyOnJobCompletion: z.boolean().default(true),
  notifyOnJobFailure: z.boolean().default(true),
  notifyOnApproval: z.boolean().default(true),
  notifyOnQuestion: z.boolean().default(true),
  silentWhenFocused: z.boolean().default(true),
})

const DEFAULT_SETTINGS: DesktopNotificationSettings = DesktopNotificationSettingsSchema({} as DesktopNotificationSettings)

/** Generic, privacy-safe copy per locale — never echoes prompt, tool, or model text. */
const COPY: Record<DesktopNotificationLocale, Record<DesktopNotificationKind, DesktopNotification>> = {
  en: {
    'turn-completed': { title: 'Turn completed', body: 'A turn you started has finished.' },
    'turn-failed': { title: 'Turn needs attention', body: 'A turn you started ended with an error.' },
    'job-completed': { title: 'Background job completed', body: 'A background job has finished.' },
    'job-failed': { title: 'Background job failed', body: 'A background job needs attention.' },
    'approval-requested': { title: 'Approval needed', body: 'A tool call is waiting for your decision.' },
    'question-requested': { title: 'Question from the agent', body: 'The agent is waiting for your answer.' },
  },
  zh: {
    'turn-completed': { title: '回合已完成', body: '你发起的一个回合已结束。' },
    'turn-failed': { title: '回合需处理', body: '你发起的一个回合因错误结束。' },
    'job-completed': { title: '后台任务已完成', body: '有一个后台任务已结束。' },
    'job-failed': { title: '后台任务失败', body: '有一个后台任务需要处理。' },
    'approval-requested': { title: '需要批准', body: '有一个工具调用正在等待你的决定。' },
    'question-requested': { title: '来自 Agent 的提问', body: 'Agent 正在等待你的回答。' },
  },
}

/** One open turn being tracked for user-initiation. */
interface OpenTurn {
  readonly turn: number
  userInitiated: boolean
}

/** Raise a notification unless the focus-silence gate suppresses it. */
function emit(sink: DesktopNotificationSink, settings: DesktopNotificationSettings, kind: DesktopNotificationKind): void {
  // Approval/question requests block progress, so they always notify; completion
  // banners are suppressed while the user is already watching the window.
  const blocking = kind === 'approval-requested' || kind === 'question-requested'
  if (!blocking && settings.silentWhenFocused && sink.isFocused()) return
  sink.notify(COPY[sink.locale][kind])
}

/** A background job settled: notify on completion/failure per the gates. */
function trackJob(sink: DesktopNotificationSink, settings: DesktopNotificationSettings, snapshot: JobSnapshot): void {
  if (snapshot.status === 'completed' && settings.notifyOnJobCompletion) emit(sink, settings, 'job-completed')
  else if (snapshot.status === 'failed' && settings.notifyOnJobFailure) emit(sink, settings, 'job-failed')
}

/**
 * Fold one session event into the open-turn tracker and notify at the relevant
 * commit points: `approval/asked` (always), and `turn/end` for a turn the user
 * initiated. Subagent sessions are skipped entirely.
 */
function trackSessionEvent(
  sink: DesktopNotificationSink,
  settings: DesktopNotificationSettings,
  openTurns: Map<string, OpenTurn>,
  session: Session,
  event: SessionEvent,
): void {
  if (session.header.origin === 'subagent') return
  const sessionId = String(session.header.id)

  if (event.type === 'approval/asked') {
    if (settings.notifyOnApproval) emit(sink, settings, 'approval-requested')
    return
  }
  if (event.type === 'turn/start') {
    openTurns.set(sessionId, { turn: event.data.turn, userInitiated: false })
    return
  }
  if (event.type === 'user/message') {
    const openTurn = openTurns.get(sessionId)
    if (openTurn !== undefined && event.data.source.kind === 'user') openTurn.userInitiated = true
    return
  }
  if (event.type !== 'turn/end') return

  const openTurn = openTurns.get(sessionId)
  if (openTurn === undefined || openTurn.turn !== event.data.turn) return
  openTurns.delete(sessionId)
  if (!openTurn.userInitiated) return

  const reason = event.data.reason.kind
  if (reason === 'completed' && settings.notifyOnTurnCompletion) emit(sink, settings, 'turn-completed')
  else if ((reason === 'error' || reason === 'max-tokens') && settings.notifyOnTurnFailure) emit(sink, settings, 'turn-failed')
}

/**
 * Compose the Consumer: register the live settings scope, then observe the
 * session-event stream and the jobs registry. Everything is effect-scoped, so
 * disposal unwinds the watchers and listeners with the host tree.
 * @param ctx - the composing context.
 */
export function apply(ctx: Context): void {
  // The sink is a shell capability, absent outside the desktop app. Probing it
  // (not requiring it) lets the same composition boot headless or on the web,
  // where notifications are a no-op.
  const sink = ctx.get('desktopNotifications')
  if (sink === undefined) return

  let settings = DEFAULT_SETTINGS
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => {
      const scope = settingsCtx.settings.register(
        DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE,
        DesktopNotificationSettingsSchema,
        { applies: 'live' },
      )
      settings = scope.get()
      const stopWatching = scope.watch((next) => { settings = next })
      return () => {
        stopWatching()
        settings = DEFAULT_SETTINGS
      }
    }, 'desktop-notifications: settings scope')
  })

  ctx.inject(['jobs'], (jobsCtx) => {
    jobsCtx.effect(
      () => jobsCtx.jobs.onJobDone((snapshot) => { trackJob(sink, settings, snapshot) }),
      'desktop-notifications: background job attention',
    )
  })

  ctx.inject(['sessions'], (sessionsCtx) => {
    sessionsCtx.effect(() => {
      const openTurns = new Map<string, OpenTurn>()
      const stopEvents = sessionsCtx.on('session/event', (session, event) => {
        trackSessionEvent(sink, settings, openTurns, session, event)
      })
      const stopDisposed = sessionsCtx.on('session/disposed', (session) => {
        openTurns.delete(String(session.header.id))
      })
      return () => {
        stopDisposed()
        stopEvents()
      }
    }, 'desktop-notifications: session attention')
  })
}
