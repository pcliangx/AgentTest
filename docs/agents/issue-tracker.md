# Issue tracker: GitHub Issues

本仓库的实现任务统一使用
[GitHub Issues](https://github.com/pcliangx/agent-squad-hq/issues)。GitHub 是任务范围、验收标准、
状态、依赖关系、认领记录和讨论历史的唯一 truth；禁止在 `.scratch/` 或其他仓库文件中
维护 issue 正文、状态或依赖关系的镜像。

产品 spec、ADR、PLAN 与领域词汇仍保存在仓库中，负责产品和架构契约；它们不是第二套
issue tracker。GitHub Issue 不能静默覆盖 Accepted ADR，方向变化必须同时更新对应文档。

## 发布约定

- 一项可独立验收的纵向工作对应一个 GitHub Issue，不创建本地 ticket 文件。
- Issue 正文使用 `What to build` 与可勾选 `Acceptance criteria`，从用户可观察结果描述。
- Triage 使用 [`triage-labels.md`](./triage-labels.md) 中的 GitHub labels。
- 阻塞关系只使用 GitHub 原生 Relationships 中的 `blocked by` / `blocking`，正文不复制
  `Blocked by` 列表。
- 有依赖的 Issues 仍可标记 `ready-for-agent`，但只有全部 blocking Issues 已关闭时才进入
  frontier。
- Issue comments 保存认领、实施中的关键判断、验证结果与交付记录；聊天内容不是状态源。

## 读取与认领

1. 收到 Issue 编号或 URL 后，读取完整正文、comments、labels 和原生依赖，再查看代码。
2. Frontier 是 open、已完整说明且全部原生依赖已关闭的 Issue；不要认领仍被阻塞的项。
3. 认领时评论 `Claimed by Claude Code` 或 `Claimed by Codex`，移除 `ready-for-agent`，
   添加 `in-progress`；适合时再设置 assignee。
4. 并行工作必须使用互斥模块或独立 worktree，并在 Issue comment 中记录分支/worktree
   边界，不能通过本地状态文件协调。

## 完成与阻塞

- 完成前逐项核对 acceptance criteria，并在 comment 中记录实际改动、关键决定、验证、
  未运行的真实 E2E/GUI、风险和后续事项。
- 验收全部满足后关闭 Issue；关闭动作是依赖 frontier 前进的唯一完成信号。
- 缺少外部信息时保持 open，使用 `needs-info` 并说明所需输入；不要用关闭表示阻塞。
- 不要因为代码已提交就自动关闭 Issue，也不要在未满足验收时勾选完成项。

## 常用命令

```bash
gh issue view <number> --repo pcliangx/agent-squad-hq --comments
gh issue list --repo pcliangx/agent-squad-hq --state open
gh issue edit <number> --repo pcliangx/agent-squad-hq --add-label in-progress
gh issue close <number> --repo pcliangx/agent-squad-hq --comment '<delivery record>'
```

当前 `gh` 版本未暴露 dependency JSON 字段时，通过 GitHub 网页 Relationships 或官方
Issue Dependencies REST API 读取依赖，不能退回正文 `Blocked by` 或本地副本。
