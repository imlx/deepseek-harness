# Agent Note: Electron desktop shape over file:// and an IPC transport

Status: proposed

English | [中文](2026-08-14-electron-file-ipc-transport.zh.md)

## Problem

dsh ships browser (`web`), one-shot (`headless`), CLI, and ACP shapes, but no desktop application. A desktop shape is the natural home for users who want a self-contained window without running a local server. The codebase already anticipates this shape without implementing it: `packages/host/webserver` declares itself "Web shape only — Electron loads dist over `file://` and carries fetch over an IPC bridge," and `AbstractApiClient.doFetch` in `packages/host/apiproxy` names "IPC bridge" as an expected transport alongside browser fetch and the in-process `http://dsh.internal` injection. The seams exist; the Electron side that plugs into them does not. Today there is no `apps/electron`, no IPC `doFetch` implementation, and no IPC carrier for the WebSocket downlink.

## Proposal

Add an Electron desktop shape as a composition over existing seams, never a patch to the loop:

1. **Renderer loads `apps/web/dist` over `file://`.** The frontend is already a pure Vite build (`@deepseek-ai/dsh-web-frontend`); no local HTTP server is needed in the renderer.
2. **An IPC `doFetch` transport.** A new `AbstractApiClient` subclass implements `doFetch` over `ipcRenderer.invoke`; the main process answers via `ipcMain.handle`, forwarding into the in-process `toFetchHandler(apiProxy)` exactly as the `http://dsh.internal` injection does today.
3. **An IPC carrier for the downlink.** The `connection` RPC layer (`HostConnectionRpc` / `ClientConnectionRpc`) is transport-independent; carry its channels and the server-push downlink over a dedicated IPC channel (`webContents.send`) instead of a WebSocket.
4. **A new `apps/electron` main-process shell** that boots the Cordis tree (composing `dsh-base` plus a headless-style bundle), opens a `BrowserWindow`, and loads `dist` over `file://`.
5. **Native capabilities land as seam providers**, following `packages/host/directory-picker-native` — never hardcoded into the shell.

The work is staged: a minimal proof of concept that sends one message and renders the model reply in an Electron window first; only after the transport seam is proven do native capabilities and profile/bundle packaging follow.

## Acceptance criteria

- An `apps/electron` shell launches a window that loads `apps/web/dist` over `file://` with no local HTTP server in the renderer.
- A new `AbstractApiClient` subclass carries requests over an IPC bridge; the renderer issues no browser `fetch` to a loopback server.
- The session downlink reaches the renderer over IPC, so a live conversation updates without a WebSocket.
- The PoC sends one user message and renders the streamed assistant reply, replayed keylessly through the snapshot harness like any other product-visible shape.
- No change to `agent-loop` or any core package; every contribution is a plugin on a documented seam.

## Risks

- The `file://` origin and the browser-trust fence in `connection` (`api-request-trust.ts`) assume a trusted HTTP authority; the IPC bridge must establish an equivalent trust posture for a non-HTTP origin rather than weaken the fence.
- The WebSocket downlink carries ordering and lifecycle semantics the IPC carrier must reproduce faithfully; a lossy or reordered push breaks session-event fidelity.
- `AbstractApiClient`'s envelope batching and health deadlines assume a fetch-shaped carrier; the IPC bridge must preserve unary-timeout and streaming behavior, not just move bytes.

## Alternatives considered

- **Embed the existing webserver and load `http://localhost`.** Rejected as the primary shape: it keeps a network listener (and its trust fence) alive purely to serve the same machine, and contradicts the documented `file://` + IPC direction. It remains a viable early scaffolding step while the IPC transport is built, but is not the target shape.
- **Fork the frontend for Electron.** Rejected: `apps/web/dist` is already a server-agnostic Vite build; forking it would duplicate UI surface that `pnpm run duplication` and the capability-seam policy both forbid.
- **Put the Electron shell in `packages/` rather than `apps/`.** Rejected: the shell is a composition/bin entry like `apps/cli` and `apps/web`, not a reusable capability package.
