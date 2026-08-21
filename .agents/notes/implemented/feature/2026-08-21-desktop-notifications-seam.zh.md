# Agent Note: 桌面通知作为 capability seam

状态：已实现

[English](2026-08-21-desktop-notifications-seam.md) | 中文

## 问题

Electron 桌面壳需要原生通知（回合结束、后台任务落定、待批准），让离开窗口的用户知道有工作需要他们。竞品 `anywhere-labs/deepseek-harness-desktop` 有这个功能，但它把一个庞大的 `DesktopRuntime` 上帝接口绑到 host 上，并让壳走本地 HTTP server。harness 既定的桌面蓝图是 `file://` + IPC 桥、一切皆 cordis 插件，所以通知必须是一条 capability seam，而不是壳里写死。

## 决策

新增 `packages/interaction/desktop-notifications`，一个三角色 seam：

- **Service Definition**——`DesktopNotificationSink`（`notify`/`isFocused`/`focus`/`locale`），与环境无关、不含 Electron，以可选的 `desktopNotifications` 上下文槽位（`DESKTOP_NOTIFICATIONS_KEY`）暴露。它沿用 launch-environment 模式（用 `ctx.get` 读取的命名槽位），而非必需的 Service 注入，因为 web/headless 组合不挂载 sink，Consumer 在那里必须空操作而非让必需注入失败。
- **Service Provider**——Electron 壳在 `main.ts` 的 boot `prepare` 里注册一个由 `electron.Notification` 支撑的 sink（在任何配置项挂载之前，好让 Consumer 在组合期间能探测到它）。`isFocused`/`focus` 读取一个延迟的窗口引用，因为 sink 在 `BrowserWindow` 存在之前就被提供了。
- **Consumer**——一个函数插件（`name`/`inject`/`apply`），订阅权威的进程内 `session/event` 流与 `jobs.onJobDone`，绝不走网络下行。它在用户主动回合结束（`turn/end`）、任务落定、或 `approval/asked` 时弹横幅。它跟踪 `turn/start` + `user/message`（`source.kind === 'user'`）以便只通知用户主动发起的回合，并整体跳过 subagent 会话。

文案通用且隐私安全（不含 prompt/工具/模型文本——系统通知中心会留存横幅）。七个实时设置开关位于 `dsh-desktop-notifications` 命名空间（`applies: 'live'`），其中包括竞品没有的差异化项：待批准通知、完成横幅的聚焦静默、点击聚焦。提问通知被刻意暂缓：提问走 `ctx.userQuestions.ask()` 而非 `session/event`，要接线需要 Consumer 注册为 `userQuestions` 的 provider（见包 README 的 Known Limitations）。

加载一个 dsh profile 并不依赖、由 overlay 挂载的插件需要两个壳侧机制：`collect-runtime.mjs` 用壳自己声明的依赖作为遍历种子（壳包无法从自己的目录解析为根），以及 `main.ts` 除 dsh 锚点外还从壳的 manifest 修复 profile 模块回退（该修复是幂等的），使 dev 模式的 loader 能解析该插件。

## 已考虑的替代方案

- **用主进程 mux 订阅驱动通知**（壳↔dsh 桥地基）：否决——`session/event` 是 mux 投影的上游，携带了帧所省略的信息（`session.header.origin`、`user/message.source`），且 cordis 插件能免费获得官方 settings seam。mux 地基留给必须由壳而非插件拥有的能力（托盘、插件管理）。
- **巨型 `DesktopRuntime` 上下文接口**（竞品的形态）：否决——它把托盘/更新/终端/通知耦进一个上帝接口；窄的按能力划分的 sink 让每条 seam 可独立测试、可回馈上游。
- **现在就用 provider 装饰器做提问通知**：因范围而否决——单 provider 的 `userQuestions` 槽位与渲染端委托需要各自的验证；此处先预留开关与文案类别。

## 后果

- 桌面路线的通知能力完全落在官方插件系统内：无本地 server、无第二条壳通道、无并行存储。
- 该包在桌面壳之外空操作，因此 web 与 headless 组合不受影响（由一个无 sink 的测试覆盖）。
- fork 在 `packages/interaction/` 下新增一个包；壳获得 provider 接线。两者均可回馈上游。
