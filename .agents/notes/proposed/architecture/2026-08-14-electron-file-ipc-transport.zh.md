# Agent Note：基于 file:// 与 IPC transport 的 Electron 桌面形态

Status: proposed

[English](2026-08-14-electron-file-ipc-transport.md) | 中文

## Problem

dsh 目前提供浏览器（`web`）、一次性（`headless`）、CLI 与 ACP 形态，但没有桌面应用。桌面形态是那些希望拥有自包含窗口、而不必运行本地服务器的用户的自然归宿。代码库已经预见了这一形态却尚未实现：`packages/host/webserver` 自我声明为"仅 Web 形态——Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch"；`packages/host/apiproxy` 中 `AbstractApiClient.doFetch` 的注释把"IPC bridge"列为与浏览器 fetch、进程内 `http://dsh.internal` 注入并列的预期 transport。接缝已存在，缺失的是接入这些接缝的 Electron 一端：没有 Electron 渲染进程 transport、没有 Electron 主进程壳，也没有承载下行的 IPC 通道。

## Proposal

把 Electron 桌面形态作为对现有接缝的组合来新增，绝不对循环打补丁：

1. **渲染进程经 `file://` 加载 `apps/web/dist`。** 前端已是纯 Vite 构建（`@deepseek-ai/dsh-web-frontend`）；渲染进程无需本地 HTTP 服务器。
2. **在现有 `connection` 包内实现 IPC transport。** 新增 `ElectronApiClient extends AbstractApiClient`，用 preload 安装的 `window.dshIpc` 桥实现 `doFetch`，并 override `openMux`/`openHost` 以经 IPC 接收服务端推送帧、替代 WebSocket——正如 `WebApiClient` 为浏览器 override 这两个方法一样。connection 插件的 client `apply()` 增加一个并列分支：当 `window.dshIpc` 存在时选择 `ElectronApiClient` 加一个 IPC 通用 RPC 调用器，与现有 `?fixture` 分支和浏览器分支并列。这保持了整个 `ConnectionController` 重连循环、`ConnectionHandle` 组装与 RPC 校验的共享，只改两个 transport 选择点。
3. **一个 Electron 主进程壳（`apps/electron`）。** 主进程经公开的 `@deepseek-ai/dsh-app-boot` API 在进程内引导一个 dsh profile，经 overlay patch 禁用每个绑定端口与浏览器图的行，并桥接网关：unary 调用转发到 `toFetchHandler(apiProxy)`，每个下行流在进程内迭代 `apiProxy.events` 并经 IPC 把帧推给渲染进程。不挂 `webserver`、不设浏览器信任围栏——主进程是同一应用，HTTP 威胁模型在此不适用。
4. **原生能力落地为接缝 Provider**，遵循 `packages/host/directory-picker-native`——绝不硬编码进壳。

工作分阶段进行：IPC transport 与一个最小壳先端到端证明载体可行；完整动态模块系统 UI（无 webserver 组图）与上游门禁在 transport 被证明后跟进。

## Acceptance criteria

- `ElectronApiClient` 经 IPC 桥承载 unary 调用与两条下行流；渲染进程不向回环服务器发出浏览器 `fetch`，也不打开 WebSocket。
- connection 插件的 `apply()` 在 `window.dshIpc` 存在时选择 Electron 载体，且 fixture query 保持优先；单元测试针对一个 mock 桥固定 transport 选择、unary 跳转、下行帧解析、中止/取消与通用 RPC 调用器。
- 一个 `apps/electron` 壳能启动窗口，经 `file://` 加载前端且无本地 HTTP 服务器，发出一条用户消息并渲染流式的助手回复。
- 不改动 `agent-loop` 或任何核心包；每一项贡献都是挂在文档化接缝上的插件。

## Risks

- `file://` 源与 `connection` 中的浏览器信任围栏（`api-request-trust.ts`）假定了一个可信 HTTP 权威；IPC 桥接必须为非 HTTP 源建立等价的信任姿态，而不是削弱围栏。Electron 壳把桥限定在它自己 preload 安装的 `window.dshIpc`，但打包后的应用还必须校验 `event.senderFrame`，以确保只有它自己的渲染进程能调用该桥。
- 下行帧信封必须精确匹配：渲染进程的 `readIpcStream` 解析完整的 `ServerRequest` 形态，所以主进程在推送前必须把每个窄 `RpcRequest<frame>` 包装好（method = 该帧的 type）——不匹配会被读作畸形帧并静默丢弃整条流。
- `AbstractApiClient` 的信封批处理与健康超时假定了一个 fetch 形态的载体；IPC 桥接必须保持一元超时与流式行为，而不仅仅是搬运字节。

## Alternatives considered

- **一个独立的 `dsh-client-connection-electron` 包提供 `ctx.connection`。** 考虑过并否决：`ConnectionController`、`ConnectionHandle` 组装与 `createWebConnectionRpc` 是 `dsh-client-connection` 的包私有成员，且 client bundle 纯度门禁禁止并列包对它们做 value-import。独立包要么得重复约 200 行的重连控制器（`pnpm run duplication` 所禁止），要么得放宽共享纯度白名单（更重的、全仓库范围的规则改动）。在现有包内加一个并列分支是更小、更对称的改动。
- **内嵌现有 webserver 并加载 `http://localhost`。** 作为目标形态被否决：它纯粹为了服务本机而维持一个网络监听器（及其信任围栏），并违背文档记载的 `file://` + IPC 方向。在构建 IPC transport 期间，它仍是可行的早期脚手架步骤。
- **为 Electron fork 前端。** 否决：`apps/web/dist` 已是服务器无关的 Vite 构建；fork 它会重复 UI 表面，`pnpm run duplication` 与能力缝政策都禁止这样做。
