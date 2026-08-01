# ADR-0008：Project-first 与可命名 Agent 实例

- 状态：已接受（Accepted）
- 日期：2026-07-31
- 关联：[ADR-0002](./0002-per-agent-git-worktree.md)、[ADR-0004](./0004-at-at-explicit-routing.md)、[PLAN-v0.2](../PLAN-v0.2.md)

## 决策

AgentTest 的顶层对象是 **Project**，不是 Task，也不是 Claude/Codex/Kimi 三个固定
pane。每个 Project 可以创建任意数量的 **Agent Instance**；实例由用户命名并选择
一个 Agent Provider，同一 Provider 可以出现多次，例如 `cc_data` 与 `cc_sql`
都使用 Claude Code。

Agent Tab 是实例的视图入口，Panel 是承载一组 Tab 的可见区域。关闭 Tab 不删除
实例或会话；拆分 Panel 用于同时观察多个实例。Task、Candidate 与 Handoff 都属于
Project 或 Agent Instance 内部流程，不能取代 Project → Agent Workspace 主层级。

## 后果

- 当前代码中的 `AgentId = claude | codex | kimi` 实际表示 Provider，后续必须与
  `AgentInstanceId` 分离；runtime、session、PTY、worktree 和 IPC 都按实例标识，
  registry/adapter 仍按 Provider 标识。
- ADR-0002 的隔离粒度明确为 `(project, agent instance)`，不再是每个 Provider
  一个 worktree。
- ADR-0004 的目标名后续改为项目内 Agent Name，例如 `@@cc_data`；当存在多个同类
  Provider 时，`@@claude` 不能唯一标识目标。`@@all` 的范围是当前 Project。
- 工作区布局是 Project 的持久状态；Agent 进程停止、Tab 关闭和实例删除是三个不同
  动作，UI 必须分别表达。
