# CLAUDE.md

本文件是 **Claude Code 的项目入口**。AgentTest 由 Claude Code 与 Codex
对等协同开发；共享工程规则不在这里复制维护。

每次任务开始前，必须完整读取并遵守：

1. [`AGENTS.md`](./AGENTS.md) —— Claude Code/Codex 共用规则与协作协议；
2. [`CONTEXT.md`](./CONTEXT.md) —— Project、Agent Instance、Tab 与 Panel 领域词汇；
3. [`docs/HANDOFF.md`](./docs/HANDOFF.md) —— 当前架构、状态、代码地图和已知坑；
4. [`docs/PLAN-v0.2.md`](./docs/PLAN-v0.2.md) —— 当前产品目标和实施路线；
5. 与任务相关的 Accepted ADR，当前重点是
   [`ADR-0008`](./docs/adr/0008-project-first-agent-instances.md)。

不要把 `AGENTS.md` 理解成只给 Codex 的文件，也不要在本文件建立一套与其平行的
架构约定。若共享规则需要调整，优先修改 `AGENTS.md`；只有 Claude Code 专属的
工具或 memory 入口才写在这里。

## Claude Code 专属注意事项

- 开工前先检查 Git 状态，保留用户或 Codex 的未提交改动。
- 不要因为历史 HANDOFF 由另一 agent 编写就重做已完成实现；以当前代码、测试和
  最新 ADR 为准。
- 改变架构或协议时，使用中性表述同步 ADR/HANDOFF，不写成单向“交接给 Claude”
  或“交接给 Codex”。
- commit/push 仅在用户明确要求时执行；共同作者信息只记录真实参与者。

## Agent skills

### Issue tracker

Issues and specs live as Markdown files under `.scratch/<feature-slug>/`.
See [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md).

### Triage labels

Five canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`.
See [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md).

### Domain docs

This is a single-context repository. Read relevant ADRs and any root
`CONTEXT.md` if present.
See [`docs/agents/domain.md`](./docs/agents/domain.md).
