# Agent Note：基于 file:// 与 IPC transport 的 Electron 桌面形态

Status: proposed

[English](2026-08-14-electron-file-ipc-transport.md) | 中文

## Problem

dsh 目前提供浏览器（`web`）、一次性（`headless`）、CLI 与 ACP 形态，但没有桌面应用。桌面形态是那些希望拥有自包含窗口、而不必运行本地服务器的用户的自然归宿。代码库已经预见了这一形态却尚未实现：`packages/host/webserver` 自我声明为"仅 Web 形态——Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch"；`packages/host/apiproxy` 中 `AbstractApiClient.doFetch` 的注释把"IPC bridge"列为与浏览器 fetch、进程内 `http://dsh.internal` 注入并列的预期 transport。接缝已存在，缺失的是接入这些接缝的 Electron 一端。今天没有 `apps/electron`、没有 IPC `doFetch` 实现，也没有承载 WebSocket 下行的 IPC 通道。

## Proposal

把 Electron 桌面形态作为对现有接缝的组合来新增，绝不对循环打补丁：

1. **渲染进程经 `file://` 加载 `apps/web/dist`。** 前端已是纯 Vite 构建（`@deepseek-ai/dsh-web-frontend`）；渲染进程无需本地 HTTP 服务器。
2. **一个 IPC `doFetch` transport。** 新增一个 `AbstractApiClient` 子类，用 `ipcRenderer.invoke` 实现 `doFetch`；主进程通过 `ipcMain.handle` 应答，并完全照搬今天 `http://dsh.internal` 注入的做法，转发进进程内的 `toFetchHandler(apiProxy)`。
3. **一个承载下行的 IPC 通道。** `connection` 的 RPC 层（`HostConnectionRpc` / `ClientConnectionRpc`）是 transport 无关的；用一条专用 IPC channel（`webContents.send`）承载其通道与服务端推送下行，替代 WebSocket。
4. **新增 `apps/electron` 主进程壳**，它引导 Cordis 树（组合 `dsh-base` 与一个 headless 风格的 bundle）、打开 `BrowserWindow`，并经 `file://` 加载 `dist`。
5. **原生能力落地为接缝 Provider**，遵循 `packages/host/directory-picker-native`——绝不硬编码进壳。

工作分阶段进行：先做能发出一条消息并在 Electron 窗口渲染模型回复的最小概念验证；只有在 transport 接缝被证明可行之后，才跟进原生能力与 profile/bundle 打包。

## Acceptance criteria

- 一个 `apps/electron` 壳能启动窗口，经 `file://` 加载 `apps/web/dist`，渲染进程内无本地 HTTP 服务器。
- 新增一个 `AbstractApiClient` 子类经 IPC 桥接承载请求；渲染进程不再向回环服务器发出浏览器 `fetch`。
- 会话下行经 IPC 到达渲染进程，使实时对话无需 WebSocket 即可更新。
- PoC 能发出一条用户消息并渲染流式的助手回复，并像其他产品可见形态一样通过快照工具无钥匙回放。
- 不改动 `agent-loop` 或任何核心包；每一项贡献都是挂在文档化接缝上的插件。

## Risks

- `file://` 源与 `connection` 中的浏览器信任围栏（`api-request-trust.ts`）假定了一个可信 HTTP 权威；IPC 桥接必须为非 HTTP 源建立等价的信任姿态，而不是削弱围栏。
- WebSocket 下行承载着 IPC 通道必须忠实复现的排序与生命周期语义；有损或乱序的推送会破坏会话事件保真度。
- `AbstractApiClient` 的信封批处理与健康超时假定了一个 fetch 形态的载体；IPC 桥接必须保持一元超时与流式行为，而不仅仅是搬运字节。

## Alternatives considered

- **内嵌现有 webserver 并加载 `http://localhost`。** 作为首要形态被否决：它纯粹为了服务本机而维持一个网络监听器（及其信任围栏），并违背文档记载的 `file://` + IPC 方向。在构建 IPC transport 期间，它仍是可行的早期脚手架步骤，但不是目标形态。
- **为 Electron fork 前端。** 否决：`apps/web/dist` 已是服务器无关的 Vite 构建；fork 它会重复 UI 表面，`pnpm run duplication` 与能力缝政策都禁止这样做。
- **把 Electron 壳放进 `packages/` 而非 `apps/`。** 否决：壳是像 `apps/cli`、`apps/web` 一样的组合/二进制入口，不是可复用的能力包。
