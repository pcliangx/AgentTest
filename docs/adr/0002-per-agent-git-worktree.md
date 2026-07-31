# ADR-0002：每 agent 一个 git worktree 隔离

- 状态：已接受（Accepted）
- 日期：2026-07-31
- 关联：[PLAN-v0.1](../PLAN-v0.1.md)、[agent-adapter-architecture §11](../../agent-adapter-architecture.md)、[ADR-0003](./0003-yolo-auto-approve-per-worktree.md)

## 背景（Context）

模式 3（广播 + 单发）下，一条 `@@all` 会把同一任务同时派给 3 个会改文件、跑工具的编码 agent。若共享同一个 cwd，三家会同时改同一批文件、互相覆盖，无法公平对比实现。

## 决策（Decision）

每个 `(baseRepo, agent)` 分配一个独立的 **git worktree**，基于同一 commit 各自独立改动。`WorktreeManager` 统一负责增删，**不按 agent 名分支**。单发（`@@claude`）是"只起一个 worktree"的特例，复用同一套机制。

worktree 根目录默认放在 base 仓库之外（避免污染主仓库工作树），路径可配置。

## 后果（Consequences）

- **正面**：同一基线、各自独立改动，diff 即对比——正是模式 3 广播的核心价值；blast radius 在文件层被隔离，与 [ADR-0003](./0003-yolo-auto-approve-per-worktree.md) 的 YOLO 姿态互为兜底。
- **负面 / 代价**：要求被操作对象是 git 仓库；非 git 目录的纯问答任务需一条降级路径（共享只读 cwd）；多一份 worktree 创建 / 清理成本。
