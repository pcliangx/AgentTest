# ADR-0007：结构化 Chat 为默认通道，PTY 仅用于 Terminal 接管

- 状态：已接受（Accepted）
- 日期：2026-07-31
- 取代：[ADR-0006](./0006-v0.1-pty-primary.md)
- 关联：[ADR-0001](./0001-v0.1-oneshot-resume-model.md)、[ADR-0002](./0002-per-agent-git-worktree.md)、[调研报告](../research/open-design-agent-communication.md)

## 背景（Context）

ADR-0006 为快速获得三家原生 TUI，将 PTY 定为默认 agent 通道。但 raw
terminal bytes 没有可靠的回合边界、工具状态、usage、session id 和错误分类；
`@@` 路由也只能模拟键盘输入，程序无法确认消息是否被 agent 消费。

对 open-design 当前源码的调研表明，它的 Claude Code、Codex、Kimi 对话主链路
均为 `spawn(..., { shell: false })` 加管道化 stdin/stdout/stderr，并按各厂商协议
归一化事件。`node-pty` 只服务独立交互终端。此前“不流式”和“UI 像日志”分别是
Claude partial 参数/decoder 与 UI 呈现问题，并非结构化协议的固有限制。

## 决策（Decision）

默认 Chat 通道采用“每 turn 一个结构化子进程”：

- `AgentAdapter` 声明 executable、argv、输入格式、协议 decoder 和会话策略；
  registry 只组合定义，router/runtime 禁止按 `agentId` 写分支。
- `AgentRuntime` 负责每 agent 单活动 run、worktree cwd、会话恢复、成功回合持久化、
  取消与事件派发。
- `RunManager` 统一使用参数数组和 `shell: false` 启动进程；POSIX 使用独立进程组，
  取消时先 SIGTERM、后 SIGKILL。
- renderer 只消费归一化 `AgentEvent`，展示 assistant、thinking、tool、usage、
  warning、error 与确定的生命周期状态，不解析 ANSI。

三家协议保持各自原生形态：

| Agent | 结构化通信 | 跨 turn 连续性 |
| --- | --- | --- |
| Claude Code | `-p` + stream-json stdin/stdout；支持时启用 partial events | 捕获 session id，后续 `--resume` |
| Codex | `codex exec --json`；prompt 写 stdin 后 EOF | 捕获 thread id，后续 `exec resume` |
| Kimi Code | `kimi acp`；ACP JSON-RPC `initialize → session/new → session/prompt` | 当前每轮新 ACP session，由 bounded transcript 回放 |

协议的 `turn-complete` 与 OS 进程 `close` 是两个边界：前者停止接收本轮语义事件，
后者才释放 run、允许 Terminal 接管或清理 worktree。仅在退出码为 0、协议已完成且
无 protocol error 时持久化会话和 transcript。失败的 native resume 会清除失效
session id，下轮以已完成 transcript 重建上下文。

PTY 保留，但职责收缩为每 pane 显式选择的 **Terminal**：

- Terminal 运行 agent 原生 TUI，支持键盘、resize 和人工操作。
- 同一 agent 的结构化 run 与 Terminal PTY 互斥。
- Terminal bytes 不参与 `@@` 默认路由，也不被反向推断为语义事件。

## 后果（Consequences）

- **正面**：`@@` 派发有确定接收路径；三家事件可统一测试和渲染；工具、usage、
  错误、取消和会话恢复不依赖 ANSI 猜测；PTY 仍保留原生 TUI 价值。
- **代价**：每 turn 有 CLI 冷启动；需维护三种协议 decoder/driver；结构化 Chat
  的交互质量取决于自研 UI；Kimi 暂用 bounded transcript，长对话会被截断。
- **验证责任**：fixture/fake CLI 覆盖协议和生命周期；真实 CLI 测试通过
  `AGENTTEST_E2E=1` 显式运行，避免默认测试消耗额度。
