# @deepseek-ai/dsh-desktop-notifications

English | [中文](README.zh.md)

The desktop-notification capability seam: the `DesktopNotificationSink` Service Definition a shell provides, the event-driven Consumer plugin that turns session/job events into native notifications, and the live settings that gate them. The package is environment-agnostic — it never imports Electron — so the host tree, the desktop shell, and tests share the one contract. The desktop shell (Electron's main process) registers a sink backed by the OS notification center; web and headless compositions mount no sink, and the Consumer no-ops there.

## The sink contract

`DesktopNotificationSink` is the capability the shell provides. `notify(notification)` raises one native banner and must not throw — a notification is best-effort attention, never a failure the agent loop observes. `isFocused()` reports whether the desktop window has focus, so the Consumer can suppress completion banners while the user is already watching. `focus()` reveals and focuses the window (the click-to-focus affordance). `locale` selects the copy language.

The shell fills the optional `desktopNotifications` context slot (`DESKTOP_NOTIFICATIONS_KEY`) before the config tree mounts, following the launch-environment pattern: the Consumer reads it with `ctx.get` and no-ops when the slot is empty, so the same composition boots headless or on the web. This is a probed capability, not a required service injection.

## What notifies

The Consumer subscribes the authoritative in-process `session/event` stream and the jobs registry — never the network downlink — so it observes the same commit points the session log records:

- **User-initiated turn closed** (`turn/end`): `completed` raises a success banner; `error`/`max-tokens` raise a failure banner. A turn is user-initiated only when it carried a `user/message` whose `source.kind` is `'user'`; turns opened by queued follow-ups, goals, or scheduling do not notify. Subagent sessions (`session.header.origin === 'subagent'`) are skipped entirely so a busy parent does not re-signal its own delegation.
- **Background job settled** (`jobs.onJobDone`): `completed`/`failed` each raise a banner.
- **Approval requested** (`approval/asked`): always notifies, even while focused — an approval blocks the turn until a human decides, so it must never be silenced by focus.

Copy is generic and privacy-safe: a banner names the kind of event, never the prompt, tool arguments, or model text, because OS notification centers persist banners beyond the app's lifetime. Copy renders in English or Chinese from the sink's `locale`.

## Settings

Seven live gates under the `dsh-desktop-notifications` namespace, all defaulting on, hot-reloaded through the settings seam (`applies: 'live'`): `notifyOnTurnCompletion`, `notifyOnTurnFailure`, `notifyOnJobCompletion`, `notifyOnJobFailure`, `notifyOnApproval`, `notifyOnQuestion`, and `silentWhenFocused`. The last suppresses only turn/job completion banners while focused; approval and question requests always notify. `notifyOnQuestion` is reserved for the deferred question wiring below and currently gates nothing.

## Model Experience

None, as this package only observes the session and jobs streams and raises a native notification; it never contributes to a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Question-asked notifications are not wired** — questions do not flow through the in-process `session/event` stream; they go through `ctx.userQuestions.ask()`, answered by a single registered UI provider (`UserQuestionService.registerProvider` throws on a duplicate). Raising a banner on a question therefore requires the Consumer to register as a `userQuestions` provider and delegate to the real answering UI, which is deferred. The `notifyOnQuestion` gate and the `question-requested` copy kind are already in place for it.
- **The sink is shell-provided** — this package ships no notification backend; without a shell registering `desktopNotifications`, the Consumer is an inert no-op. The Electron desktop app is the reference provider.
