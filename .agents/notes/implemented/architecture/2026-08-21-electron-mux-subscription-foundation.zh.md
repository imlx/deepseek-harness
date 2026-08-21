# Agent Note: 桌面壳在主进程订阅 mux 事件流

状态：已实现

[English](2026-08-21-electron-mux-subscription-foundation.md) | 中文

## 问题

Electron 桌面壳需要通知、托盘、插件管理（这是相对 `anywhere-labs/deepseek-harness-desktop` 的差异化路线——对方起本地 `127.0.0.1` HTTP server 并用 `loadURL` 加载 UI）。这些能力必须由权威会话事件流驱动——`approval/asked`、`turn/end`、`error`——但此前**主进程**无法观测这条流。`api.events.mux()` 唯一的现有消费者是渲染端下行（经 IPC `dsh:openStream` 桥），壳自己拿不到。

竞争对手起了一个本地 server。而 harness 既定的桌面蓝图是 `file://` + IPC 桥，所以壳必须复用它已有的传输，而不是新增 server 或第二条仅壳用的通道。

## 决策

新增一个可复用的主进程订阅模块 `apps/electron/src/events.ts`，导出 `subscribeMuxEvents(events, sink)`。它在进程内迭代**现有的** `api.events.mux()` 异步流——与渲染端消费的是同一条下行——因此壳不新增任何传输、端点或 server。每个 `MuxFrame` 按其 `type` 判别式窄化为语义化 sink 回调（`onApprovalRequested`、`onTurnEnd`、`onQuestionRequested`、`onSessionEvent`、`onError`），桌面功能挂在这些回调上。

`SessionEventMap` 是 merge-可扩展的（schedule、llm-retry、agent 等都向它 merge 成员），所以派发器**不**对该联合 `assertNever`：任何它未建模的帧变体落入文档化默认分支并被忽略，使地基在上游新增事件类型时保持稳定。新桌面功能扩展 sink，而非传输。订阅返回一个 disposer，仅中止本泵；`main.ts` 在 `window-all-closed` 时把它与既有 `ctx.fiber.dispose()` 回收一并接入。

此改动需要把 `@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-user-approval`、`@deepseek-ai/dsh-user-questions` 声明为 `apps/electron` 的依赖（此前只链接了 `dsh-host-apiproxy`）：类型感知 lint 与包边界导入约定都经 `node_modules` 解析跨包导入，而 `node_modules` 只链接已声明的依赖。相应的 `tsconfig` 项目引用也已补上（对齐 `apps/cli`，它本就引用 `core/session`）。

## 已考虑的替代方案

- **经 `handler.fetch('/api/events.mux')` 驱动订阅并解析 SSE**：否决——它只是为拿到同样的帧而多叠一层 server-sent-events 解码；直接调 `api.events.mux()` 是进程内的同构点，且与 host 已暴露的面保持对称。
- **为壳→渲染的能力信号开第二条仅壳用 IPC 通道**：否决——它会与既有 `dsh:openStream` 下行并行、割裂桥的契约；地基保持单一传输。
- **对 `MuxFrame` 联合 `assertNever`**：否决——merge-可扩展的 `SessionEventMap` 意味着该联合是开放的；封闭 switch 会在某个包 merge 新事件类型时反复破坏构建。

## 后果

- 桌面路线（通知、托盘、插件管理）挂在同一条可复用订阅上，均不触碰传输。
- `apps/electron` 获得首个单测套件（`tests/events.spec.ts`），被根 vitest 配置的 `apps/*/tests/**/*.spec.ts` glob 自动收集；该包此前既无测试也无 invariant（package-invariant 门禁只扫 `packages/*/*`）。
- fork 的 `packages/` 树未改动——地基通过已声明的依赖消费已导出的类型（`EventsApi`、`MuxFrame`、`SessionEvent`）。
