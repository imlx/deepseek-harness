# Agent Note: Electron desktop shape over file:// and an IPC transport

Status: proposed

English | [中文](2026-08-14-electron-file-ipc-transport.zh.md)

## Problem

dsh ships browser (`web`), one-shot (`headless`), CLI, and ACP shapes, but no desktop application. A desktop shape is the natural home for users who want a self-contained window without running a local server. The codebase already anticipates this shape without implementing it: `packages/host/webserver` declares itself "Web shape only — Electron loads dist over `file://` and carries fetch over an IPC bridge," and `AbstractApiClient.doFetch` in `packages/host/apiproxy` names "IPC bridge" as an expected transport alongside browser fetch and the in-process `http://dsh.internal` injection. The seams exist; the Electron side that plugs into them does not. There is no Electron renderer transport, no Electron main-process shell, and no IPC carrier for the downlink.

## Proposal

Add an Electron desktop shape as a composition over existing seams, never a patch to the loop:

1. **Renderer loads `apps/web/dist` over `file://`.** The frontend is already a pure Vite build (`@deepseek-ai/dsh-web-frontend`); no local HTTP server is needed in the renderer.
2. **An IPC transport inside the existing `connection` package.** A new `ElectronApiClient extends AbstractApiClient` implements `doFetch` over the preload-installed `window.dshIpc` bridge and overrides `openMux`/`openHost` to receive server-pushed frames over IPC instead of a WebSocket — exactly how `WebApiClient` overrides those two for the browser. The connection plugin's client `apply()` gains one parallel branch: when `window.dshIpc` is present it selects `ElectronApiClient` plus an IPC generic-RPC caller, alongside the existing `?fixture` and browser branches. This keeps the whole `ConnectionController` reconnect loop, the `ConnectionHandle` assembly, and the RPC validation shared, changing only the two transport selection points.
3. **An Electron main-process shell (`apps/electron`).** The main process boots a dsh profile in-process over the public `@deepseek-ai/dsh-app-boot` API, disables every port-binding and browser-graph row through an overlay patch, and bridges the gateway: it instantiates `HostConnectionService` on the root context so the Typert gateway registers its Remote interceptor, and unary POSTs dispatch through the service’s shared-channel handler - Remote endpoints claimed by the interceptor first, the unary routes of `toFetchHandler(apiProxy)` as fallback, the same order the web `/api` route serves. Each downlink stream iterates `apiProxy.events` in-process and pushes frames to the renderer over IPC. No `webserver`, no browser trust fence - the main process is the same application, so the HTTP threat model does not apply.
4. **Native capabilities land as seam providers**, following `packages/host/directory-picker-native` — never hardcoded into the shell.

The work is staged: the IPC transport and a minimal shell prove the carrier end to end first; the full dynamic-module-system UI (composing the client graph without a webserver) and upstream gating follow once the transport is proven.

## Acceptance criteria

- `ElectronApiClient` carries unary calls and the two downlink streams over an IPC bridge; the renderer issues no browser `fetch` to a loopback server and opens no WebSocket.
- The connection plugin's `apply()` selects the Electron carrier when `window.dshIpc` is present, with the fixture query keeping precedence; unit tests pin the transport selection, the unary hop, downlink framing, abort/cancel, and the generic-RPC caller against a mocked bridge.
- An `apps/electron` shell launches a window that loads the frontend over `file://` with no local HTTP server, sends one user message, and renders the streamed assistant reply.
- No change to `agent-loop` or any core package; every contribution is a plugin on a documented seam.

## Risks

- The `file://` origin and the browser-trust fence in `connection` (`api-request-trust.ts`) assume a trusted HTTP authority; the IPC bridge must establish an equivalent trust posture for a non-HTTP origin rather than weaken the fence. The Electron shell confines the bridge to its own preload-installed `window.dshIpc`, but a packaged app must additionally verify `event.senderFrame` so only its own renderer can invoke the bridge.
- The downlink frame envelope must match exactly: the renderer's `readIpcStream` parses the full `ServerRequest` form, so the main process must wrap each narrow `RpcRequest<frame>` (method = the frame's type) before pushing — a mismatch reads as malformed frames and silently drops the stream.
- `AbstractApiClient`'s envelope batching and health deadlines assume a fetch-shaped carrier; the IPC bridge must preserve unary-timeout and streaming behavior, not just move bytes.

## Alternatives considered

- **A separate `dsh-client-connection-electron` package providing `ctx.connection`.** Considered and rejected: `ConnectionController`, the `ConnectionHandle` assembly, and `createWebConnectionRpc` are package-private to `dsh-client-connection`, and the client-bundle purity gate forbids a sibling package value-importing them. A separate package would have to either duplicate the ~200-line reconnect controller (which `pnpm run duplication` forbids) or widen the shared purity whitelist (a heavier, repo-wide rule change). A parallel branch inside the existing package is the smaller, symmetric change.
- **Embed the existing webserver and load `http://localhost`.** Rejected as the target shape: it keeps a network listener (and its trust fence) alive purely to serve the same machine, and contradicts the documented `file://` + IPC direction. It remains a viable early scaffolding step while the IPC transport is built.
- **Fork the frontend for Electron.** Rejected: `apps/web/dist` is already a server-agnostic Vite build; forking it would duplicate UI surface that `pnpm run duplication` and the capability-seam policy both forbid.
