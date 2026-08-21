# Agent Note: Desktop notifications as a capability seam

Status: implemented

English | [中文](2026-08-21-desktop-notifications-seam.zh.md)

## Problem

The Electron desktop shell needs native notifications (turn finished, background job settled, approval waiting) so a user away from the window knows work needs them. The competing `anywhere-labs/deepseek-harness-desktop` ships this, but bolts a large `DesktopRuntime` god-interface onto the host and routes the shell through a local HTTP server. The harness's declared desktop blueprint is `file://` + the IPC bridge with everything as a cordis plugin, so notifications must be a capability seam, not a shell hardcode.

## Decision

Add `packages/interaction/desktop-notifications`, a three-role seam:

- **Service Definition** — `DesktopNotificationSink` (`notify`/`isFocused`/`focus`/`locale`), environment-agnostic and Electron-free, exposed as the optional `desktopNotifications` context slot (`DESKTOP_NOTIFICATIONS_KEY`). It follows the launch-environment pattern (a named slot read with `ctx.get`), not a required Service injection, because web/headless compositions mount no sink and the Consumer must no-op there rather than fail a required injection.
- **Service Provider** — the Electron shell registers a sink backed by `electron.Notification` in `main.ts`'s boot `prepare` (before any config entry mounts, so the Consumer can probe it during composition). `isFocused`/`focus` read a late window reference, since the sink is provided before the `BrowserWindow` exists.
- **Consumer** — a function plugin (`name`/`inject`/`apply`) that subscribes the authoritative in-process `session/event` stream and `jobs.onJobDone`, never the network downlink. It raises a banner for a user-initiated turn closing (`turn/end`), a job settling, or an `approval/asked`. It tracks `turn/start` + `user/message` (`source.kind === 'user'`) to notify only user-initiated turns, and skips subagent sessions entirely.

Copy is generic and privacy-safe (no prompt/tool/model text — OS notification centers persist banners). Seven live settings gates sit under the `dsh-desktop-notifications` namespace (`applies: 'live'`), including the differentiators the competing project lacks: approval-requested notifications, focus-silence for completion banners, and click-to-focus. Question-asked notifications are deliberately deferred: questions flow through `ctx.userQuestions.ask()`, not `session/event`, so wiring them needs the Consumer to register as a `userQuestions` provider (see the package README's Known Limitations).

Two shell-side mechanics were required to load an overlay-mounted plugin the dsh profile does not depend on: `collect-runtime.mjs` seeds its walk with the shell's own declared dependencies (the shell package does not resolve as a root from its own directory), and `main.ts` heals the profile module fallback from the shell's manifest in addition to the dsh anchor (the heal is idempotent) so the dev-mode loader resolves the plugin.

## Alternatives considered

- **Drive notifications off the main-process mux subscription** (the shell↔dsh bridge foundation): rejected — `session/event` is the upstream of the mux projection and carries what the frames omit (`session.header.origin`, `user/message.source`), and a cordis plugin gets the official settings seam for free. The mux foundation stays for capabilities the shell, not a plugin, must own (tray, plugin management).
- **A giant `DesktopRuntime` context interface** (the competing project's shape): rejected — it couples tray/update/terminal/notifications into one god-interface; a narrow per-capability sink keeps each seam independently testable and upstreamable.
- **Question notifications via a provider decorator now**: rejected for scope — the single-provider `userQuestions` slot and renderer delegation need their own verification; the gate and copy kind are reserved instead.

## Consequences

- The desktop roadmap's notification capability ships entirely inside the official plugin system: no local server, no second shell channel, no parallel store.
- The package no-ops outside the desktop shell, so web and headless compositions are unaffected (covered by a no-sink test).
- The fork gains a new package under `packages/interaction/`; the shell gains the provider wiring. Both are upstreamable.
