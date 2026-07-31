# Open Design 与 Claude Code / Codex / Kimi 的通信方式调研

> 调研对象：`/Users/pc2026/Documents/GitHubResearch/open-design`
>
> 源码版本：`b323a2811116b0220c9b1046f43177f113fc3d9b`（2026-07-30）
>
> 调研方式：只读追踪当前 runtime 定义、子进程启动、协议解析、会话恢复、Daemon API 与 Web UI；未把归档设计稿当作现状依据。

## 结论

Open Design 的 agent 对话主链路**不用 PTY**。它把 Claude Code、Codex、Kimi 都当作无头子进程，用 Node.js `child_process.spawn()` 启动，固定 `shell: false`，通过管道化 `stdin/stdout/stderr` 交换结构化协议。公共启动点会根据 runtime 定义选择是否打开 stdin，然后以 `stdio: [stdinMode, "pipe", "pipe"]` 启动进程（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:6626-6680`）。

这里还有一个关键差别：Open Design 的 **chat run 是每 turn 启动一个新子进程**，并不为每个 agent 保留常驻 CLI。Web 每次消息创建一个 run 并获得新的 `runId`（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/routes/runs.ts:1115-1133`），该 run 在启动路径中创建并持有自己的 child（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:6591-6609`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:6670-6687`），turn 结束后关闭 stdin、等待子进程 close 并完成 run（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/chat-run-lifecycle.ts:98-118`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:7746-7756`）。跨 turn 连续性由 session id 或 transcript 恢复，不靠暖进程。

三者并没有强行统一到同一种厂商协议，而是在 daemon 内归一化：

| Agent | CLI 启动模式 | 输入 | 输出 | 原生会话恢复 |
|---|---|---|---|---|
| Claude Code | `claude -p --input-format stream-json --output-format stream-json --verbose` | 一行 Claude `user` JSON，写入 stdin | Claude stream-json / JSONL | `--resume <session-id>` |
| Codex | `codex exec --json --skip-git-repo-check` | 原始 prompt 文本写入 stdin，随后 EOF | Codex JSONL event stream | `codex exec resume ... <thread-id>` |
| Kimi Code | `kimi acp` | ACP JSON-RPC 2.0，newline-delimited stdin | ACP JSON-RPC 2.0，newline-delimited stdout | **当前 Kimi runtime 未启用** `session/load`；每次 `session/new`，由上层补完整 transcript |

Web UI 也不直接连接 CLI。主路径是：

```text
React/Next Web
  -- POST /api/runs ----------------------> Express daemon
  <-- GET /api/runs/:id/events（SSE）----- 规范化事件
                                             |
                                             +-- spawn + stdin/stdout pipes --> agent CLI
```

Open Design 确实依赖 `node-pty`，但它被放在**独立的交互式终端子系统**中：PTY 启动用户 shell，输出走 SSE，键盘输入与 resize 走 HTTP POST。它不是 Claude/Codex/Kimi 对话 runtime 的传输层（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/terminals.ts:10-17`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/routes/terminal.ts:10-18`）。

这对 AgentTest 的启示不是“PTY 错了”，而是应按职责分层：

- 要完整保留原生 TUI、终端快捷键、交互式命令，PTY 是合适且几乎不可替代的。
- 要稳定做 `@@` 路由、结构化 tool call、token/usage、错误分类、会话恢复和可测试 UI，厂商提供的 headless/structured protocol 更合适。
- 本报告的建议是**结构化通道作为默认编排主通道，PTY 保留为 Terminal / 人工 takeover**；不要从 ANSI 屏幕内容反推语义事件。

## 1. 公共 runtime 层

Open Design 用声明式 `RuntimeAgentDef` 描述不同 agent。定义中直接包含参数构造、输入格式、输出流格式、事件 parser，以及 CLI/ACP 会话恢复能力（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/types.ts:101-140`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/types.ts:190-209`）。当前 registry 明确注册 Claude、Codex 和 Kimi 的实现（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/registry.ts:30-57`）。

实际运行时：

1. daemon 解析 runtime 可执行文件；Codex 还会优先寻找平台原生 binary，找不到才回退 wrapper（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/launch.ts:15-36`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/launch.ts:88-107`）。
2. 使用 `spawn(command, args, { cwd, env, shell: false, detached, stdio })`；POSIX 上独立进程组便于取消整棵子进程（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:6626-6687`）。
3. stdout/stderr 均按 UTF-8 文本消费，再交给各自 parser（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:6770-6781`）。

因此，这条路径是“CLI + pipes + 协议 adapter”，不是 vendor SDK、HTTP API 或 PTY。这里的结论只限定于这三个**本地 runtime**；仓库其他 BYOK/API 功能不在本次范围内。

## 2. Claude Code：stream-json over stdio

### 启动与输入

Claude runtime 固定使用打印模式，并显式请求双向 stream-json：

- 基础参数是 `-p --input-format stream-json --output-format stream-json --verbose`（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/claude.ts:45-59`）。
- runtime 声明 `promptViaStdin: true`、`promptInputFormat: "stream-json"`、`streamFormat: "claude-stream-json"`（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/claude.ts:77-98`）。
- daemon 把最终 prompt 包成 `{type:"user", message:{role:"user", content:[{type:"text", text:...}]}}`，序列化为一行 JSON 后写入 stdin（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:8326-8354`）。

权限模式由 runtime 参数设为 `--permission-mode bypassPermissions`（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/claude.ts:77-98`），因此这不是依赖终端 UI 点选确认的交互模式。

### 输出解析

Claude parser 按换行缓冲并 `JSON.parse()` 每条消息（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/claude-stream.ts:346-375`），然后把厂商事件映射成统一事件：

- `system/init` 提取 session id 和状态（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/claude-stream.ts:377-397`）。
- assistant content 映射文本、thinking 和 `tool_use`，并避免在工具调用中间误判 turn 结束（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/claude-stream.ts:400-467`）。
- tool result、usage、error 分别归一化（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/claude-stream.ts:486-533`）。
- 流式 text/thinking/tool-input delta 也单独处理（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/claude-stream.ts:559-615`）。

生命周期代码只会在 clean terminal turn 后关闭 Claude stdin，而不会在 `tool_use` 一出现就关闭（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/chat-run-lifecycle.ts:85-118`）。

### 会话恢复

Claude 首次运行可以传 `--session-id`，恢复则传 `--resume`（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/claude.ts:77-98`）。成功后 daemon 持久化指定或捕获的 session id（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:6241-6310`）。

**状态：当前已实现、已注册的生产路径。**

## 3. Codex：`codex exec --json` + JSONL

### 启动与输入

Codex runtime 采用非交互 `exec`：

- 新会话参数核心是 `codex exec --json --skip-git-repo-check`（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/codex.ts:180-230`）。
- runtime 明确启用 `promptViaStdin`，并记录裸 `-` 参数在当前 CLI 上不兼容，因此不使用它（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/codex.ts:173-180`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/codex.ts:274-283`）。
- 因为它不是 Claude 的 stream-json 输入格式，公共代码把原始 prompt 写入 stdin 后结束输入（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:8361-8365`）。

runtime 还会把 cwd/additional dirs、model、reasoning effort、service tier 和 sandbox 配置映射为 CLI 参数（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/codex.ts:234-271`）。

### 输出解析

Codex stdout 是 JSONL：

- `thread.started.thread_id` 被捕获为可恢复 session id，错误事件归一化为 error（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/json-event-stream.ts:658-703`）。
- command execution 映射为 `tool_use/tool_result`（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/json-event-stream.ts:705-779`）。
- agent message 映射文本，turn completed 映射 usage（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/json-event-stream.ts:783-813`）。
- parser 逐行缓冲、解析 JSON，并按 `kind === "codex"` 分派（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/json-event-stream.ts:819-871`）。

### 会话恢复

恢复命令是 `codex exec resume --json ... <thread-id>`（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/codex.ts:180-230`）。stream 中捕获的 thread id 会写入持久化 session（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:7343-7363`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:6241-6310`）。

**状态：当前已实现、已注册的生产路径。**

## 4. Kimi Code：ACP JSON-RPC over stdio

### 启动与握手

当前 Kimi runtime 的实际定义非常明确：启动 `kimi acp`，输出格式是 `acp-json-rpc`，并允许把外部 MCP server 合入会话（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/kimi.ts:4-27`）。

ACP 层是 JSON-RPC 2.0 over stdio：

- request/response 都序列化为单行 JSON，加换行后写 stdin（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/acp/rpc.ts:9-34`）。
- stdout parser 能处理分片 JSON line，并带有 multiline fallback（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/core/json-line-stream.ts:8-23`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/core/json-line-stream.ts:63-121`）。
- 启动后先发送 `initialize`（protocol version 1，client capabilities 中 terminal 为 false），再建 session（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/acp/session.ts:915-939`）。
- session/new 参数包含 cwd 和 MCP stdio server 描述；prompt 支持文本与图片 resource link（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/acp/session-params.ts:45-105`）。
- 最终通过 `session/prompt` 发送 prompt blocks（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/acp/session.ts:474-492`）。

这证明 Kimi 不是靠解析 TUI，也不是走 Kimi 专有 HTTP：它使用标准化 ACP 进程协议。

### 事件、工具与权限

ACP `session/update` 被映射成统一事件：

- thought/message 分别映射 thinking/text（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/acp/session.ts:625-714`）。
- tool call/update 映射 `tool_use/tool_result`，并处理 artifact write（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/acp/session.ts:716-805`）。
- prompt response、usage 和完成状态在 session 层统一收口（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/acp/session.ts:871-912`）。

agent 若发出权限请求，daemon 会自动选择允许选项并返回响应，而不是把确认 UI 暴露到 PTY（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/acp/session.ts:534-558`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/acp/rpc.ts:213-228`）。

### 当前 Kimi 的“恢复”实际是 transcript 回放

ACP 通用实现支持 `session/load`：有 resume id 就 load，否则 new（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/acp/session.ts:808-831`）。但 **Kimi runtime 当前没有声明 `resumesSessionViaAcpLoad`**；daemon 只有看到该 capability 才会把 resume id 传给 ACP（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:4951-4963`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:7596-7600`）。

因此 Kimi 当前每轮走 `session/new`。连续对话靠上层提供 transcript：

- Web 把历史消息格式化为 `## role` transcript，并把最新 prompt 分开发给 daemon（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/web/src/providers/daemon.ts:244-258`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/web/src/providers/daemon.ts:666-696`）。
- daemon 只在真正 native resume 时跳过 transcript；否则将完整 message 组成请求（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:1453-1481`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:5065-5099`）。

**状态：ACP 通信当前已实现；Kimi 的 ACP native session resume 当前未启用，实际使用 transcript 回放。**

### 一段容易误判的兼容代码

仓库还留有一个处理 OpenAI 风格 Kimi event 的 `json-event-stream` parser（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/json-event-stream.ts:351-399`）。不过只有 generic JSON-event parser 以 Kimi kind 运行时才会走到它（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/json-event-stream.ts:844-850`）；当前唯一注册的 Kimi 定义用的是 `acp-json-rpc` 且没有配置该 parser。

**状态：保留的兼容/旧路径，不是当前 Kimi runtime 主链路。**

## 5. Daemon 到 Web UI：REST 创建 run，SSE 推事件

Web 先 `POST /api/runs`，拿到 `runId`，随后开始消费事件（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/web/src/providers/daemon.ts:699-746`）。daemon 返回 `202` 与 run id（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/routes/runs.ts:1115-1133`）。

运行中的厂商事件先进入 daemon 的统一 event ring，再 fan-out 给 SSE clients（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/runs.ts:584-614`）。SSE 支持 `Last-Event-ID`/cursor replay 后接 live stream（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/runs.ts:745-771`）；传输帧由 daemon 写成标准 `id/event/data`（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/server.ts:1963-2019`）。

Web 使用 `fetch()` + `ReadableStream` 解析 SSE，并在断线时用 cursor 重连（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/web/src/providers/daemon.ts:1085-1145`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/web/src/providers/sse.ts:6-37`），再把 daemon 事件转换成 UI `AgentEvent`（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/web/src/providers/daemon.ts:1412-1505`）。

Desktop 版也没有为 agent 单独做 Electron IPC：主进程加载 web app，`/api/*` 由 web sidecar 代理到 daemon（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/desktop/src/main/runtime.ts:138-152`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/desktop/src/main/runtime.ts:2120-2145`）。打包模式也明确启动独立 daemon/web sidecar（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/packaged/src/sidecars.ts:738-783`）。

仓库另有 `/api/runs/:id/agui`，它只是把 daemon 已归一化的事件映射为 AG-UI 传输（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/routes/runs.ts:2036-2082`）。这是已实现的备选上层接口，不是 agent 子进程协议，也不是当前 Web provider 的主路径。

## 6. 取消与进程清理

普通 CLI run 通过进程组先 SIGTERM、后 SIGKILL；ACP 会优先发协议级 abort，再做进程清理（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/runs.ts:939-979`）。ACP 已建立 session 时会发送 `session/cancel`，然后关闭 stdin（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/acp/session.ts:961-999`）。

这种设计比在 PTY 中模拟 Ctrl-C 更可预测：协议支持时先语义取消，不支持时仍有 OS 进程组兜底。

## 7. PTY 在 Open Design 中真正承担的角色

Open Design 的 PTY 是另一套 subsystem：

- `node-pty` 被动态加载，缺失时只影响 interactive terminal（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/services/node-pty.ts:64-74`）。
- terminal manager 用 PTY 启动 shell，设置 `xterm-color`、cwd、env 与窗口大小，直接接收 raw data/exit（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/terminals.ts:179-233`）。
- 它提供 output replay/SSE、write、resize、kill（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/terminals.ts:244-305`）。
- Web 的 xterm 组件把 EventSource 输出写入终端，把 `onData` 键盘输入 POST 回 daemon（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/web/src/components/workspace/TerminalViewer.tsx:224-317`）。

所以 Open Design 本身已经给出了一种清晰边界：

```text
语义化 agent run：spawn + structured stdio -> normalized events -> SSE UI
原生交互终端：     node-pty + raw terminal bytes -> xterm
```

## 8. 对 AgentTest ADR-0006 三个前提的判断

ADR-0006 把改用 PTY 的背景归纳为“不流式、每条冷启动、UI 像日志”（`/Users/pc2026/Documents/DevTools/AgentTest/docs/adr/0006-v0.1-pty-primary.md:7-13`）。对照 Open Design 当前实现，这三个前提需要拆开看。

### 前提一：“结构化模式不流式”

**判断：对当时那组默认参数成立，但不是结构化模式的固有限制，作为长期架构前提已经不充分。**

Open Design 会探测 Claude Code 是否支持 `--include-partial-messages`；支持时将它加入 stream-json 参数（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/claude.ts:35-38`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/claude.ts:52-65`）。parser 已处理 text、thinking 与 tool-input 的 partial delta（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/claude-stream.ts:559-615`）。Kimi ACP 也把分段 message/thought update 转为持续事件（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/agent-protocol/acp/session.ts:625-714`）。

因此，AgentTest 实测的“整轮结束才出完整 assistant event”是真问题，但更准确的结论是“当时 adapter 缺少 partial flag/decoder”，而不是“pipes/structured protocol 无法流式”。Codex、Kimi 的具体粒度仍应按当前已安装 CLI 做 E2E probe，不能由 Claude 的结果外推。

### 前提二：“每条冷启动”

**判断：进程冷启动属实；“模型冷读”及其用户影响尚未量化，不能单独证明 PTY 应成为编排主通道。**

Open Design 同样选择每 turn 一个新进程，却仍用结构化通道作为 chat 主路径。它用 Claude `--resume` 与 Codex `exec resume` 保存厂商侧上下文，而不是依赖本地 CLI 常驻（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/claude.ts:77-85`、`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/defs/codex.ts:180-230`）。所以可确认的成本是本地 CLI 启动、认证/config/MCP 初始化；是否存在显著“模型冷读”，以及相对首 token/完整 turn 占比，应通过三家 CLI 的 p50/p95 基准验证。

这个前提是 PTY 暖进程的真实优势，但要与结构化事件、确定性 turn 边界、可恢复 session、可测试性和取消语义的收益一起权衡。

### 前提三：“结构化 UI 像日志”

**判断：这是当前 UI 呈现问题，不是通信协议限制。**

Open Design 把厂商输出归一化为 text/thinking/tool/usage/error/session 等事件，而非把 stdout 原样打印（统一事件合同见 `/Users/pc2026/Documents/GitHubResearch/open-design/packages/contracts/src/sse/chat.ts:107-159`）；Web 再将 daemon events 映射为 UI `AgentEvent`（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/web/src/providers/daemon.ts:1412-1505`）。同一结构化数据既可做聊天气泡，也可做工具进度卡、diff、状态栏或审计日志。

原生 TUI 的确能以最低开发成本获得厂商已打磨的 UI，这是 PTY 的产品价值；但“自研结构化 UI 当前像日志”不等于“结构化 UI 必然像日志”。

### 综合判断

ADR-0006 对 v0.1 快速得到三家原生 TUI 是合理的阶段性决策，也如实记录了 PTY 的负面后果：回合边界、usage、session id 只能从 bytes 推断，且 `@@` 注入无法证明已被消费（`/Users/pc2026/Documents/DevTools/AgentTest/docs/adr/0006-v0.1-pty-primary.md:24-28`）。但 Open Design 的实现证据削弱了把它升级为长期默认编排架构的三个前提：第一、第三并非协议固有限制，第二需要性能数据。

## 9. 对 AgentTest 的建议

AgentTest 当前强调“每 agent 一个常驻原生 TUI PTY”。如果这项体验是核心承诺，继续用 PTY 是合理的：Claude Code、Codex、Kimi 的全屏 TUI 都依赖伪终端能力，普通 pipe 无法等价复刻终端尺寸、控制序列、交互输入和 TUI 状态。

但 PTY 不应同时承担结构化控制面的全部职责。建议把目标架构明确为：**结构化通道负责默认编排，PTY 负责 Terminal / takeover。**

1. **默认 structured runtime adapter**：Claude 用 stream-json，Codex 用 `exec --json`，Kimi 用 ACP；统一输出 text/thinking/tool/usage/error/session 事件，供 `@@` 路由、状态机、并排比较和自动化测试使用。
2. **保留 PTY runtime**：作为每个 agent 的 Terminal / 人工接管入口，负责原生 TUI、CLI 特有命令、疑难交互和最大兼容性；它不是编排状态的权威来源。
3. **router 面向统一 capability/事件协议**：不要从 terminal screen 或 ANSI 文本识别“agent 已完成”“工具正在运行”等状态。
4. **会话策略按 agent 能力区分**：Claude/Codex 使用原生 session id；Kimi 在明确验证 `session/load` 兼容前，保留 transcript replay。
5. **取消采用两级策略**：先协议级 cancel/关闭 stdin，再用进程组信号兜底。

推荐的默认交互是：用户从统一输入栏发出的 `@@` 请求走 structured runtime；需要观察/操作原生 TUI 时，用户显式进入相应 agent 的 Terminal 或点击 takeover。这样 PTY 的价值全部保留，同时正常编排不再依赖无法验证的字节注入。

实施前建议先补一组同机 E2E 基准：三家分别测试 fresh/resume 的进程启动耗时、首事件、首文本、完整 turn p50/p95，以及 partial/event 完整性。若结构化通道的额外首 token 延迟确实不可接受，再考虑特定 agent 的长期 duplex 进程；这仍不要求把 ANSI PTY 作为统一语义协议。

## 10. 本机 CLI 能力核验

2026-07-31 在 AgentTest 当前机器只执行 `--version/--help`，未发起模型请求，结果如下：

| CLI | 本机版本 | help 实际暴露的能力 | 与 Open Design adapter 的对应 |
|---|---:|---|---|
| Claude Code | `2.1.220` | `--input-format`、`--output-format`、`--include-partial-messages`、`--resume`、`--session-id`；help 明确 stream-json 与 print mode 的组合 | 可采用 input/output stream-json、partial messages，并用 session id 跨进程 resume |
| Codex CLI | `0.146.0` | `codex exec --json` 输出 JSONL；`codex exec resume [SESSION_ID] [PROMPT]`；prompt 可从 stdin 读取 | 可采用 `exec --json`，捕获 thread/session id 后在下一进程用 `exec resume` |
| Kimi Code | `0.31.0` | `kimi acp` 的 help 明确说明“ACP server over stdio” | 可采用 ACP JSON-RPC over stdio；help 本身未证明 Kimi 支持 `session/load`，因此仍按当前 Open Design 定义的 `session/new` + transcript 策略看待 |

本机能力核验确认三条结构化 transport 在当前安装版本均可用，但不改变进程生命周期结论：

- Open Design 对每个 chat run/turn 都重新 `spawn()` CLI。
- Claude 的 stream-json stdin 只在**当前 run 内**保持到 terminal turn，随后由 bookkeeping 关闭（`/Users/pc2026/Documents/GitHubResearch/open-design/apps/daemon/src/runtimes/chat-run-lifecycle.ts:98-118`）；它不是跨多个 turn 常驻的 duplex 进程。
- Claude、Codex 依靠 session id/thread id 在新进程中续接上下文。
- Kimi 当前没有启用 ACP `session/load`，所以新进程中 `session/new`，并由上层回放完整 transcript。

以上 `--help` 核验只证明 CLI 参数/子命令存在；实际事件 schema、首 token 延迟、resume 正确性与权限行为仍应由不烧额度的 fixture 测试和受控真实 E2E 分别验证。
