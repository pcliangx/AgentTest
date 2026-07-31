# Adapter stream-json probe — 2026-07-31

> 三家 CLI 的真实调用方式、事件 schema、以及 probe 中暴露的跨切面问题。
> Sanitized 样本见各 `fixtures/sample.jsonl`。本结论供 Phase 1 decoder 实现参考。

## 工作调用（已验证）

| Agent | 命令 | 关键点 |
| --- | --- | --- |
| Claude Code | `claude -p "<text>" --output-format stream-json --verbose --dangerously-skip-permissions` | `--output-format stream-json` 在 print 模式**必须配 `--verbose`**，否则报错；stdin 需接 `/dev/null` |
| Kimi Code | `kimi -p "<text>" --output-format stream-json` | `-p` 模式**不能与 `--auto` 同用**（报 `Cannot combine --prompt with --auto`）；prompt 模式本就非交互 |
| Codex | `codex exec "<text>" --json --dangerously-bypass-approvals-and-sandbox` | `--json` = JSONL；沙箱/审批旁路用该 flag |

探测 cwd：隔离的临时 git 仓库（`/tmp/agenttest-probe`，已 `git init`），避免污染主仓库。

## 事件 schema（各家不同——印证 per-adapter decoder 的必要）

**Claude Code** — `{type, subtype, ...}`
- `system/init`：含 `session_id`、`tools`、`model`、`permissionMode`。
- `assistant`：`message.content[].text`（助手文本）+ `message.usage`。
- `result`：汇总——`session_id`、`usage`、`total_cost_usd`、`result`、`terminal_reason:"completed"`、`subtype:"success"`。
- session_id 来源：`system/init` 或 `result`。resume：`claude -p ... --resume <session_id>`。

**Kimi Code** — 极简 `{role, ...}`
- `{role:"assistant", content:"..."}`。
- `{role:"meta", type:"session.resume_hint", session_id, command}`——**直接给出 resume 命令**。
- session_id 来源：`meta/session.resume_hint`。resume：`kimi -r <session_id>`（或 `-S`）。

**Codex** — `{type, ...}`，thread/turn/item 模型
- `thread.started`（`thread_id`）、`turn.started`、`item.completed`（嵌套 `item`，含 message/error 等）、`error`。
- thread_id 来源：`thread.started`。resume：`codex exec resume` / `codex resume`。

## probe 暴露的跨切面问题（Phase 1 必须处理）

1. **配置继承导致巨噪**：嵌套调用继承了用户环境的全部 hooks/plugins/MCP/skills。Claude 的 `system/init` 事件体积巨大（列出全部工具/skill/plugin/MCP/路径），且 SessionStart hook 把 superpowers 全文注入输出；Codex 也有 `Skill descriptions were shortened`。**Phase 1 各 adapter 应以"干净 profile"启动**（如 claude 指向精简 settings、禁用 hooks/plugins；codex/kimi 隔离配置），否则 stdout 被非业务事件淹没。
2. **模型经代理**：Claude 实际模型为 `glm-5.2[1m]`、`apiKeySource:"none"`；Codex 出现 WebSocket→HTTPS 回退与多次 `request timed out`。环境走代理（与 `Magic-Proxy` 一致）。**Electron 应用若复用同一环境，需确认代理/鉴权可达；Codex exec 当前因网络重试而"看似卡住"**。
3. **resume 可靠性待验证**：三家都暴露了 session/thread id，但 `--resume` 是否真恢复完整上下文仍需 per-adapter fixture 验证（ADR-0001 的已知风险）。Kimi 直接给 resume 命令，最易接入。

## 对计划的影响

- Claude-first 顺序成立：Claude 与 Kimi 的 schema 清晰、resume 信号明确，先做；**Codex 因网络/超时与配置继承最不稳，放最后**，且 Phase 1 前需先解决其代理连通性。
- "干净 profile 启动"应作为 ADR-0001 的实施补充（不改变决策，只约束实现）。
