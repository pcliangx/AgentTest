# Agent runtime protocol probe — 2026-07-31

> 本文记录当前结构化主链路的命令、协议与验证边界。迁移依据和 open-design
> 源码定位见 [`docs/research/open-design-agent-communication.md`](../../../docs/research/open-design-agent-communication.md)。

## 本机 CLI 版本

| Agent | 版本 |
| --- | --- |
| Claude Code | 2.1.220 |
| Codex CLI | 0.146.0 |
| Kimi Code | 0.31.0 |

版本只是本次本机验证快照，不是硬编码的最低版本。可选参数必须做 capability probe，
不能只按这个版本假定所有用户都支持。

## 当前工作调用

| Agent | 启动方式 | prompt 输入 | 输出 | 会话连续性 |
| --- | --- | --- | --- | --- |
| Claude | `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode bypassPermissions` | 一行 Claude user JSON，terminal turn 后 EOF | stream-json / JSONL | `--resume <session-id>` |
| Codex | `codex exec --json --skip-git-repo-check ...` | 原始文本 stdin，立即 EOF | Codex JSONL | `codex exec resume ... <thread-id>` |
| Kimi | `kimi acp` | newline-delimited ACP JSON-RPC | newline-delimited ACP JSON-RPC | 每轮 `session/new` + bounded transcript |

所有子进程均由 `RunManager` 使用参数数组、`shell: false` 和 pipe stdio 启动；
prompt 不放在 argv 中。

## Claude Code

### 参数

- `--verbose` 是 stream-json print 模式的必要参数。
- `--include-partial-messages` 只在 `claude -p --help` 包含该 flag 时加入；
  老版本不支持时仍可依赖完整 assistant/result 事件。
- structured run 使用 `--permission-mode bypassPermissions`。
- Terminal 模式单独使用 `--dangerously-skip-permissions`，不复用 structured argv。

### 输入与事件

首条 stdin：

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

decoder 处理：

- `system/init` 的 session id；
- `stream_event` 的 text、thinking、tool-input delta；
- 完整 assistant content 和 tool use；
- result usage/error/terminal reason；
- partial 与最终 assistant wrapper 的去重；
- `parent_tool_use_id` 非空的 sidechain 不驱动主回合结束。

stdin 在 terminal turn 后关闭，进程 close 后 run 才真正结束。

## Codex CLI

fresh argv 核心：

```text
exec --json --skip-git-repo-check --sandbox workspace-write
-c sandbox_workspace_write.network_access=true -C <cwd>
```

resume argv 核心：

```text
exec resume --json --skip-git-repo-check
-c sandbox_mode="workspace-write"
-c sandbox_workspace_write.network_access=true <thread-id>
```

decoder 处理 `thread.started`、turn started/completed、agent message、reasoning、
command/tool item、usage、error 与 reconnect warning。

注意：当前用户环境走代理时，Codex 可能经历 WebSocket → HTTPS 回退和网络重试，
表现为首个事件延迟；不能把无输出直接当作进程死亡。

## Kimi Code / ACP

握手顺序：

```text
initialize
  -> session/new
  -> session/prompt
  -> session/update*
  -> prompt response
```

- client capability 声明 `terminal: false`；
- `session/request_permission` 自动选择允许选项并返回 JSON-RPC response；
- message/thought chunk 映射为 assistant/thinking；
- tool call/update 映射为 tool start/end；
- prompt result 映射 usage 与 turn complete；
- 每个协议阶段有 progress watchdog；
- 取消先发 `session/cancel`，再关闭 stdin，最后由 SIGTERM/SIGKILL 兜底。

当前 Kimi adapter 未声明可靠的 ACP `session/load`，因此每轮 `session/new`，由
SessionStore 回放最多 20 个已成功回合。

## 验证层级

默认测试使用 fake CLI 覆盖：

- 三种 stdin/stdout 形态；
- partial 去重、session/thread 捕获、usage、工具事件；
- ACP permission、watchdog 与 protocol cancellation；
- clean early exit、用户取消、进程组退出；
- native resume 只发送最新 turn；
- transcript adapter 回放历史；
- repo 清理前等待 active run 真正退出。

真实 CLI E2E 必须显式开启：

```bash
AGENTTEST_E2E=1 npx vitest run <file>
```

它依赖本机鉴权、代理与模型额度。未运行时只能声称协议 fixture/fake CLI 通过，
不能声称三家真实 CLI 已完成产品冒烟验证。

## 历史 probe 的结论修正

- “Claude stream-json 不流式”只对未启用 partial 的旧参数成立，不是结构化协议限制。
- Kimi 的 `-p --output-format stream-json` 是旧实验路径；当前主链路是 `kimi acp`。
- Codex 当前采用 workspace-write sandbox，不使用
  `--dangerously-bypass-approvals-and-sandbox`。
- PTY 适合原生 TUI，但不再承担默认 `@@` 路由或结构化状态来源。
