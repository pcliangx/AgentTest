# ADR-0003：worktree 内 YOLO / auto-approve

- 状态：已接受（Accepted）
- 日期：2026-07-31
- 关联：[PLAN-v0.1](../PLAN-v0.1.md)、[ADR-0001](./0001-v0.1-oneshot-resume-model.md)、[ADR-0002](./0002-per-agent-git-worktree.md)

## 背景（Context）

模型一跑的是非交互 `-p` / `exec` 进程（[ADR-0001](./0001-v0.1-oneshot-resume-model.md)），**无法交互式弹窗授权**工具调用。若不预先给 auto-approve，agent 做不了写 / 执行类工具，编码能力形同虚设。三家各有自家的 auto-approve 开关。

## 决策（Decision）

每个 adapter 把权限意图映射到自家的 auto-approve flag，在各自 worktree 内全自动执行：

- Claude Code：`--dangerously-skip-permissions`（或 `--permission-mode bypassPermissions`）
- Kimi Code：`--auto`
- Codex：full-auto / bypass

## 后果（Consequences）

- **正面**：agent 真能干活；文件层风险被 [ADR-0002](./0002-per-agent-git-worktree.md) 的 worktree 隔离兜住（最多踩废自己的工作树，`git worktree remove` 即可丢弃）。
- **负面 / 代价（必须如实告知用户）**：worktree 隔离的是**文件**；agent 跑的 shell 命令在**本机真实执行**，理论上可越界（如删到 worktree 之外）或外发数据。Codex 自带 sandbox 较安全，Claude / Kimi 为原生执行。
- **缓解**：在 UI 与文档中显式标注此风险；远期为 Claude / Kimi 评估可选沙箱方案。
