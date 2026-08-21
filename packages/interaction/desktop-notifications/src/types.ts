/**
 * Pure-type face of the desktop-notification seam, free of cordis/service and
 * schemastery imports so type chains (the shell's adapter, tests, any consumer)
 * can consume the contract without loading the package's runtime. The Service
 * class, settings schema, and the event-driven Consumer plugin live in
 * `./index.ts`.
 *
 * Copy is deliberately generic (privacy-safe): a notification names the kind of
 * event, never the prompt, tool arguments, or model text, because OS notification
 * centers persist banners beyond the app's lifetime.
 * @module @deepseek-ai/dsh-desktop-notifications/types
 */

/** One native notification. Copy is generic on purpose — see the module doc. */
export interface DesktopNotification {
  /** Notification heading. */
  readonly title: string
  /** Concise user-facing status line. */
  readonly body: string
}

/** Locale identifiers the Consumer renders copy in. */
export type DesktopNotificationLocale = 'en' | 'zh'

/**
 * The capability the desktop shell provides: raise a native notification and
 * report/steer window focus. The Consumer talks only to this interface; the
 * shell's adapter implements it (Electron's `Notification` in the desktop app).
 */
export interface DesktopNotificationSink {
  /** Current locale for notification copy, resolved by the shell. */
  readonly locale: DesktopNotificationLocale
  /**
   * Raise one native notification. Implementations must not throw — a
   * notification is best-effort attention, never a failure the agent loop sees.
   * @param notification - the generic title/body to present.
   */
  notify(notification: DesktopNotification): void
  /**
   * Whether the desktop window currently has focus. The Consumer suppresses
   * turn/job completion banners while the user is already watching, so a
   * foreground session never double-signals. Approval/question requests are
   * exempt (they block work and always notify).
   */
  isFocused(): boolean
  /** Reveal and focus the desktop window (the click-to-focus affordance). */
  focus(): void
}

/** User-tunable gates over which events raise a notification. */
export interface DesktopNotificationSettings {
  /** A user-initiated turn finished successfully. */
  readonly notifyOnTurnCompletion: boolean
  /** A user-initiated turn failed or hit the output-token ceiling. */
  readonly notifyOnTurnFailure: boolean
  /** A background job finished successfully. */
  readonly notifyOnJobCompletion: boolean
  /** A background job failed. */
  readonly notifyOnJobFailure: boolean
  /** A tool call is waiting on a human approval decision. */
  readonly notifyOnApproval: boolean
  /** The agent asked the user a structured question. */
  readonly notifyOnQuestion: boolean
  /**
   * Suppress turn/job completion banners while the window is focused. Approval
   * and question requests always notify regardless, since they block progress.
   */
  readonly silentWhenFocused: boolean
}

/** The kinds of event that can raise a notification; indexes the copy table. */
export type DesktopNotificationKind =
  | 'turn-completed'
  | 'turn-failed'
  | 'job-completed'
  | 'job-failed'
  | 'approval-requested'
  | 'question-requested'
