# @deepseek-ai/dsh-desktop-notifications

[English](README.md) | 中文

桌面通知 capability seam：壳提供的 `DesktopNotificationSink` Service Definition、把会话/任务事件转成系统通知的事件驱动 Consumer 插件，以及控制这些通知的实时设置。本包与环境无关——它不 import Electron——因此 host 树、桌面壳与测试共享同一份契约。桌面壳（Electron 主进程）注册一个由系统通知中心支撑的 sink；web 与 headless 组合不挂载 sink，Consumer 在那里是空操作。

## sink 契约

`DesktopNotificationSink` 是壳提供的能力。`notify(notification)` 弹出一条系统横幅且不得抛错——通知是尽力而为的提醒，绝不是 agent 循环能观测到的失败。`isFocused()` 报告桌面窗口是否处于聚焦，Consumer 借此在用户已在观看时抑制完成横幅。`focus()` 唤出并聚焦窗口（点击聚焦的承载）。`locale` 选择文案语言。

壳在配置树挂载前填充可选的 `desktopNotifications` 上下文槽位（`DESKTOP_NOTIFICATIONS_KEY`），沿用 launch-environment 模式：Consumer 用 `ctx.get` 读取它，槽位为空时空操作，因此同一组合可以 headless 或在 web 上启动。这是一个被探测的能力，而非必需的服务注入。

## 什么会通知

Consumer 订阅权威的进程内 `session/event` 流与任务注册表——绝不走网络下行——因此它观测到的提交点与会话日志记录的完全一致：

- **用户主动发起的回合结束**（`turn/end`）：`completed` 弹成功横幅；`error`/`max-tokens` 弹失败横幅。一个回合仅当它携带了 `source.kind` 为 `'user'` 的 `user/message` 才算用户主动发起；由排队追问、目标或调度开启的回合不通知。subagent 会话（`session.header.origin === 'subagent'`）整体跳过，避免忙碌的父会话为自己的委派重复发信号。
- **后台任务结束**（`jobs.onJobDone`）：`completed`/`failed` 各弹一条横幅。
- **请求批准**（`approval/asked`）：总是通知，即便聚焦时亦然——批准会阻塞回合直到有人决断，因此绝不能被聚焦静默。

文案是通用且隐私安全的：横幅只说事件类别，绝不回显 prompt、工具参数或模型文本，因为系统通知中心会把横幅留存到应用生命周期之外。文案按 sink 的 `locale` 以英文或中文渲染。

## 设置

`dsh-desktop-notifications` 命名空间下的七个实时开关，默认全开，经 settings seam 热重载（`applies: 'live'`）：`notifyOnTurnCompletion`、`notifyOnTurnFailure`、`notifyOnJobCompletion`、`notifyOnJobFailure`、`notifyOnApproval`、`notifyOnQuestion`、`silentWhenFocused`。最后一项仅在聚焦时抑制回合/任务完成横幅；批准与提问请求总是通知。`notifyOnQuestion` 为下方暂缓的提问接线预留，目前不控制任何通知。

## Model Experience

无，本包只观测会话与任务流并弹出系统通知；它从不参与任何模型请求。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **提问通知尚未接线**——提问不流经进程内 `session/event` 流；它走 `ctx.userQuestions.ask()`，由唯一注册的 UI provider 应答（`UserQuestionService.registerProvider` 对重复注册抛错）。因此要在提问时弹横幅，需要 Consumer 注册为 `userQuestions` 的 provider 并委托给真实的问答 UI，此接线暂缓。`notifyOnQuestion` 开关与 `question-requested` 文案类别已为它备好。
- **sink 由壳提供**——本包不带任何通知后端；没有壳注册 `desktopNotifications` 时，Consumer 是惰性空操作。Electron 桌面应用是参考实现。
