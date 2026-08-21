# Agent Note: Desktop shell subscribes the mux stream in the main process

Status: implemented

English | [中文](2026-08-21-electron-mux-subscription-foundation.zh.md)

## Problem

The Electron desktop shell needs notifications, tray, and plugin management (the differentiated roadmap against `anywhere-labs/deepseek-harness-desktop`, which runs a local `127.0.0.1` HTTP server and loads the UI over `loadURL`). Those capabilities must be driven by the authoritative session-event stream — `approval/asked`, `turn/end`, `error` — but the shell had no way for the **main process** to observe that stream. The only existing consumers of `api.events.mux()` were the renderer's downlink (over the IPC `dsh:openStream` bridge), not the shell itself.

The competing project bolts on a local server. The harness's declared desktop blueprint is `file://` + the IPC bridge, so the shell must reuse the transport it already has rather than add a server or a second shell-only channel.

## Decision

Add a reusable main-process subscription module, `apps/electron/src/events.ts`, exporting `subscribeMuxEvents(events, sink)`. It iterates the **existing** `api.events.mux()` async stream in-process — the same downlink the renderer consumes — so the shell adds no transport, no endpoint, and no server. Each `MuxFrame` is narrowed by its `type` discriminant into semantic sink callbacks (`onApprovalRequested`, `onTurnEnd`, `onQuestionRequested`, `onSessionEvent`, `onError`) that the desktop features hang off.

The `SessionEventMap` is merge-extensible (schedule, llm-retry, agent, … all merge members in), so the dispatcher does **not** `assertNever` on the union: any frame variant it does not model falls through a documented default and is ignored, keeping the foundation stable as upstream adds event types. New desktop features extend the sink, not the transport. The subscription returns a disposer that aborts only this pump; `main.ts` wires it alongside the existing `ctx.fiber.dispose()` teardown on `window-all-closed`.

The change required declaring `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-user-approval`, and `@deepseek-ai/dsh-user-questions` as `apps/electron` dependencies (previously only `dsh-host-apiproxy` was linked): the type-aware lint and the package-boundary import convention both resolve cross-package imports through `node_modules`, which only links declared dependencies. The matching `tsconfig` project references were added (mirroring `apps/cli`, which already references `core/session`).

## Alternatives considered

- **Drive the subscription through `handler.fetch('/api/events.mux')` and parse SSE**: rejected — it adds a server-sent-events decode layer only to arrive at the same frames; calling `api.events.mux()` directly is the in-process isomorphic point and stays symmetric with what the host already exposes.
- **A second shell-only IPC channel** for shell→renderer capability signals: rejected — it would parallel the existing `dsh:openStream` downlink and split the bridge contract; the foundation keeps one transport.
- **`assertNever` on the `MuxFrame` union**: rejected — the merge-extensible `SessionEventMap` means the union is open; a closed switch would break the build each time a package merges a new event type.

## Consequences

- The desktop roadmap (notifications, tray, plugin management) hangs off one reusable subscription; none of them touches transport.
- `apps/electron` gains its first unit-test suite (`tests/events.spec.ts`), auto-discovered by the root vitest config's `apps/*/tests/**/*.spec.ts` glob; the package previously shipped no tests or invariant (the package-invariant gate scans `packages/*/*` only).
- The fork's `packages/` tree is untouched — the foundation consumes already-exported types (`EventsApi`, `MuxFrame`, `SessionEvent`) through declared dependencies.
