# AGENTS.md

## 协同定位

本仓库由 **Claude Code 与 Codex 对等协同开发**。两者都可以分析、实现、测试和
评审任意模块，不设置固定模块所有权，也不把另一方描述为临时接手者。

本文件是两者共享的工程规则源。`CLAUDE.md` 只提供 Claude Code 的入口和专属
skills 索引；如两份文件出现重复或冲突，以本文件和当前已接受 ADR 为准。

## 每次开工前

1. 完整阅读 [`docs/HANDOFF.md`](./docs/HANDOFF.md)。
2. 阅读根目录 [`CONTEXT.md`](./CONTEXT.md) 和当前产品路线
   [`docs/PLAN-v0.2.md`](./docs/PLAN-v0.2.md)。
3. 执行 `git status --short` 和 `git log -5 --oneline`，确认当前 HEAD 与未提交改动。
4. 阅读任务相关 ADR；当前领域与通道决策分别是
   [`ADR-0008`](./docs/adr/0008-project-first-agent-instances.md) 和
   [`ADR-0007`](./docs/adr/0007-structured-chat-pty-terminal.md)；产品身份见
   [`ADR-0013`](./docs/adr/0013-agent-squad-hq-product-identity.md)。
5. 涉及 Agent CLI 协议时，再读
   [`src/main/adapters/PROBE.md`](./src/main/adapters/PROBE.md)。
6. 若用户给出 GitHub Issue 编号或 URL，先读取完整正文、comments、labels 与原生依赖；
   若给出 `.scratch/<feature>/spec.md`，也须完整读取后再动代码。

事实优先级依次为：用户当前要求 → 当前代码与测试 → `CONTEXT.md` 与最新
Accepted ADR → `docs/PLAN-v0.2.md` → `docs/HANDOFF.md` → 历史规划。
`docs/PLAN-v0.1.md` 和被取代的 ADR 只作背景。

UI/UX Design Gate 已于 2026-08-02 关闭，设计基线见
[`docs/UX-v0.2.md`](./docs/UX-v0.2.md)。Phase 1“生产 UI 与契约化
Mock”已由 [#1](https://github.com/pcliangx/agent-squad-hq/issues/1)（[PR #18](https://github.com/pcliangx/agent-squad-hq/pull/18)）启动；后续按
[GitHub Issues #3–#16](https://github.com/pcliangx/agent-squad-hq/issues) 的原生依赖 frontier
实施。throwaway prototype 不能直接当生产代码。

## Claude Code / Codex 协作协议

- 两个 agent 可能共享同一个工作树；除非用户明确分配了独立 worktree，否则按共享
  工作树处理。看到不属于当前任务的改动，默认其属于用户或另一 agent，必须保留。
- 编辑前查看相关 diff；禁止用 `git reset --hard`、`git checkout --` 等方式清除
  他人改动。
- 默认串行接力。确需并行时按文件、模块或独立 worktree 拆分，避免同时编辑同一
  文件；任务状态、认领、依赖和实施记录只写入对应 GitHub Issue。
- 从当前工作树继续，不重复已经完成的工作。交接以 Git commit、当前 diff、
  HANDOFF/ADR 和测试结果为准，不依赖聊天记忆。
- 发现另一 agent 的实现存在问题时，先给出代码和测试证据，再修改；不要仅因实现者
  不同而重写。
- 架构或协议方向发生变化时，同一改动必须更新 ADR 与 `docs/HANDOFF.md`。
- 未经用户明确要求，不 commit、不 push、不删除分支或 worktree。用户要求提交时，
  只提交当前任务范围；`Co-Authored-By` 仅填写真实参与者。

完成一轮工作时，交付说明必须包含：

- 实际改变了什么；
- 关键设计决定；
- 已运行的验证及结果；
- 未运行的真实 CLI E2E / GUI 人工验证；
- 尚存风险或下一步。

## 项目速览

- Electron 壳，嵌入 Claude Code、Codex CLI、Kimi Code。
- 当前基线仍以 Provider 为固定三槽；`@@claude` / `@@codex` / `@@kimi` /
  `@@all` 由用户显式路由。
- 默认 Chat 使用结构化 stdio：
  Claude stream-json、Codex JSONL、Kimi ACP。
- 目标产品以 Project 为顶层；Project 内可创建 N 个用户命名 Agent Instance，
  同一 Provider 可以多开。
- Agent Instance 用 Tab 打开，用 Panel 分屏；关闭 Tab 不停止或删除实例。
- 目标隔离粒度是每 Agent Instance 独立 session、runtime、PTY 和 worktree。
- PTY 只用于显式 Terminal 接管；同一实例的 structured run 与 PTY 互斥。
- 可查看各 worktree 改动并以 fast-forward 合并回主仓库。
- 当前产品方向是“Project-first + N 个命名 Agent + Tab/Panel 工作区”，详见
  [`PLAN-v0.2`](./docs/PLAN-v0.2.md)。

## 不可破坏的工程约束

- registry/router 禁止 `switch(providerId)` 或等价的 Provider 特判。厂商差异
  只能放在 adapter、decoder 或 protocol driver。
- 新实现必须区分 `AgentProviderId` 与 `AgentInstanceId`；Provider registry
  按前者查 adapter，runtime/session/PTY/worktree/IPC 按后者管理实例。
- Agent Name 在 Project 内唯一；不能用 ProviderId、数组下标或 Tab/Panel ID
  代替 AgentInstanceId。
- 子进程必须使用 `spawn` / `execFileSync` 与参数数组，固定 `shell: false`；
  禁止拼接 shell 命令。
- 协议 `turn-complete` 不等于进程退出；资源释放、Terminal 接管与 worktree 清理
  以 `process-exited` / `finished` 为边界。
- 仅成功完成的回合才能持久化 native session 与 transcript。
- renderer 不解析 ANSI 来推断 agent 语义状态。
- main/preload 使用 CJS；不要给 `package.json` 添加 `"type": "module"`。
- 正式产品名必须写作 `Agent Squad HQ`；新技术标识使用 `agent-squad-hq` /
  `AGENT_SQUAD_HQ_*`。旧名称只能出现在 ADR-0013 定义的兼容迁移中。
- 重装依赖后必须运行 `npm run rebuild:native`，使 node-pty ABI 对齐 Electron。
- 面向用户的文案和项目文档用中文；代码、标识符、路径与 commit subject 用英文。
- 合并主仓库前必须二次确认、检查主仓库干净，并且只允许 `--ff-only`。

## 命令与验证

```bash
npm install --legacy-peer-deps
npm run rebuild:native
npm run dev

npm run typecheck
npm test
npm run build
npm run test:ui
```

提交前必须运行：

```bash
npm run check:release
git diff --check
```

`check:release` 在同一次生产构建后运行默认 Vitest 与确定性 Electron mock 冒烟；
`test:ui` 可单独从构建开始运行 UI 发布护栏。失败产物保存在 `test-results/`。

真实 agent 测试必须显式开启：

```bash
AGENT_SQUAD_HQ_E2E=1 npx vitest run <e2e-test-file>
```

真实 E2E 会使用本机鉴权、代理和模型额度。未运行时只能声明 fixture/fake CLI
通过，不能声称三家真实 CLI 已验证。Electron 窗口交互也必须如实标记为人工验证。

## 产品 spec / GitHub Issue 约定

- 产品 spec 可以保存在 `.scratch/<feature-slug>/spec.md`，ADR/PLAN/HANDOFF 继续在
  仓库中维护。
- 实现 ticket 只使用 [GitHub Issues](https://github.com/pcliangx/agent-squad-hq/issues)；
  Issue 正文、labels、原生 Relationships、comments 与 open/closed 状态是唯一 truth。
- 禁止创建或恢复 `.scratch/<feature-slug>/issues/` 本地 ticket 镜像。
- 详细规则见 [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md) 和
  [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md)。
- 领域文档与 ADR 读取规则见
  [`docs/agents/domain.md`](./docs/agents/domain.md)。
