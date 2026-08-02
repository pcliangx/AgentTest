# Agent Squad HQ — Claude Code / Codex 续开发文档

> 更新日期：2026-08-02 · 结构化通道基线：`ba49614` · 分支：`main`
>
> 本文是 Claude Code 与 Codex 共用的当前状态说明；实时 HEAD 和工作树状态以
> `git log` / `git status` 为准。

## 1. 这是什么

Agent Squad HQ 是一个本地多 Agent 编码工作台，以 Electron 统一编排 Claude Code、
Codex CLI 和 Kimi Code：

- 当前基线用 `@@claude` / `@@codex` / `@@kimi` / `@@all` 显式路由；
- 默认 Chat 走厂商提供的结构化 stdio 协议，事件归一化后渲染；
- 当前每个 Provider 在独立 git worktree 内运行，互不覆盖；
- 每个 pane 可显式切换到 Terminal，以 PTY 运行原生交互式 TUI；
- 可查看各 worktree 的改动，并 fast-forward 合并到主仓库。

当前产品路线见 [PLAN-v0.2](./PLAN-v0.2.md)：下一阶段从“三 pane 运行器”升级为
**Project-first 集成工作台与指挥中心**。一个 Project 可创建任意数量、用户命名的
Agent Instance；Claude Code、Codex、Kimi Code 只是 Provider。Agent 通过 Tab
打开，通过自由 split tree 中的 Panel 分屏管理。Overview、Tasks、Knowledge、
Handoffs、Activity、Attention 与 Settings 都是正式 Project 工作面。

现行架构决策见
[ADR-0007](./adr/0007-structured-chat-pty-terminal.md)：**结构化 Chat 是默认编排通道，
PTY 只负责 Terminal 接管**；产品对象决策见
[ADR-0008](./adr/0008-project-first-agent-instances.md)。工作区与生命周期、飞书信任
边界、交付顺序和可强制执行安全契约分别见
[ADR-0009](./adr/0009-command-center-workspace-lifecycle.md)、
[ADR-0010](./adr/0010-feishu-integration-trust-boundaries.md) 和
[ADR-0011](./adr/0011-ui-first-contract-driven-delivery.md)、
[ADR-0012](./adr/0012-enforced-execution-and-brokered-capabilities.md)。产品身份与旧数据
兼容迁移见 [ADR-0013](./adr/0013-agent-squad-hq-product-identity.md)。ADR-0006 已被取代。

## 2. 当前状态

| 能力 | 状态 |
| --- | --- |
| Electron + React + TypeScript + Tailwind 脚手架 | ✅ |
| `@@` 显式路由与三 pane | ✅ |
| Claude stream-json + partial capability probe + native resume | ✅ 单测；真实 E2E 需显式运行 |
| Codex `exec --json` + native thread resume | ✅ fake CLI 集成测试；真实 E2E 待跑 |
| Kimi ACP JSON-RPC + permission/cancel + transcript replay | ✅ fake CLI 集成测试；真实 E2E 待跑 |
| 归一化 Chat UI（文本、thinking、工具、usage、状态、错误） | ✅ |
| Terminal PTY 接管及结构化 run 互斥 | ✅ |
| worktree 隔离、RepoPicker、改动查看与 ff-only 合并 | ✅ |
| 仓库切换前等待结构化子进程退出 | ✅ |
| Project-first 指挥中心、Provider/Instance 与生命周期决策 | ✅ 用户已确认 |
| 飞书浏览器/CLI 身份、Project scope、CRUD 与数据主权决策 | ✅ 用户已确认 |
| A 版原始 HTML 原型 | ✅ 保留为历史基线 |
| B 版指挥中心与 Settings A/B/C 结构原型 | ✅ 专家评审完成；冻结 A 主结构 + B/C 辅助视图 |
| Design Gate | ✅ 2026-08-02 已关闭 |
| Agent Squad HQ 产品身份、技术 slug 与旧数据兼容 | ✅ [#17](https://github.com/pcliangx/agent-squad-hq/issues/17) 已完成并发布 |
| Phase 1 spec 与 GitHub Issues #1–#16 | ✅ 已迁移；GitHub 是 ticket 唯一 truth |
| 生产 UI-first + contract mock 交付顺序 | ✅ 用户已确认 |
| Phase 1 #1 Project Shell + WorkbenchPort + MockScenarioAdapter | ✅ [PR #18](https://github.com/pcliangx/agent-squad-hq/pull/18)；#2–#16 尚未启动 |
| Project、N Agent Instance 与布局持久化 | ⏳ 尚未进入生产实现 |
| Tasks、Knowledge、Attention、Handoff 与飞书集成 | ⏳ 尚未进入生产实现 |
| 三家真实 CLI 的 Electron GUI 冒烟验证 | ⏳ 需人工执行 |

旧 `TranscriptWatcher` 与 Claude transcript mapper 仍保留，但不再属于默认主链路；
不要用它们从 PTY 输出推断结构化状态。

身份迁移启动时复制 session、设置和 Chromium 数据，但不复制 linked Git worktrees；
旧 worktrees 原地保留。2026-08-02 只读检查显示当前 `claude`、`codex`、`kimi` 三个旧
worktree 均为 clean。新身份下应从 base repository 重新创建，不能把复制目录作为有效
linked worktree 使用。

## 3. 先读这些

1. 本文档。
2. [领域词汇表](../CONTEXT.md)。
3. [PLAN-v0.2](./PLAN-v0.2.md)。
4. [UX-v0.2](./UX-v0.2.md)；设计基线已冻结，Phase 1 尚未启动。
5. [ADR-0008](./adr/0008-project-first-agent-instances.md)。
6. [ADR-0009](./adr/0009-command-center-workspace-lifecycle.md)。
7. [ADR-0010](./adr/0010-feishu-integration-trust-boundaries.md)。
8. [ADR-0011](./adr/0011-ui-first-contract-driven-delivery.md)。
9. [ADR-0012](./adr/0012-enforced-execution-and-brokered-capabilities.md)。
10. [ADR-0013](./adr/0013-agent-squad-hq-product-identity.md)。
11. [ADR-0007](./adr/0007-structured-chat-pty-terminal.md)。
12. [B 版原型说明](./design/README.md)。
13. [Phase 1 spec](../.scratch/ui-first-command-center/spec.md)。
14. [Phase 1 GitHub Issues #1–#16](https://github.com/pcliangx/agent-squad-hq/issues)。
15. [open-design 通信调研](./research/open-design-agent-communication.md)。
16. [`src/main/adapters/PROBE.md`](../src/main/adapters/PROBE.md)。
17. 根目录 `agent-adapter-architecture.md`。

`docs/PLAN-v0.1.md` 和 ADR-0001 至 ADR-0006 是历史背景；发生冲突时以当前代码、
最新 Accepted ADR 和 PLAN-v0.2 为准。

## 4. 技术栈与命令

当前 `package.json` 的核心版本：

- Electron 43.2、electron-vite 5、Vite 8.2；
- React 19.2、TypeScript 7.0；
- Tailwind CSS 4.3、Vitest 4.1；
- node-pty 1.1、xterm 6。

main/preload 仍由 electron-vite 以 CJS 构建；不要给 `package.json` 添加
`"type": "module"`。

```bash
npm install --legacy-peer-deps
npm run rebuild:native
npm run dev

npm run typecheck
npm test
npm run build

AGENT_SQUAD_HQ_E2E=1 npx vitest run <e2e-test-file>
```

重装 `node_modules` 后必须重新运行 `npm run rebuild:native`，使 node-pty ABI
与 Electron 对齐。默认测试不会调用真实 agent，避免消耗额度。

## 5. 当前架构

```text
renderer (React)
  ├─ Chat: invoke agent:run / agent:cancel
  │          │
  │          v
  │   AgentRuntime -- SessionStore
  │          │
  │          v
  │     RunManager -- spawn(shell:false, pipes, per-turn process)
  │          │
  │          ├─ Claude: stream-json decoder
  │          ├─ Codex: JSONL decoder
  │          └─ Kimi: ACP JSON-RPC session driver
  │
  └─ Terminal: node-pty raw bytes <-> xterm

每条路径的 cwd -> 对应 agent 的独立 git worktree
```

### 5.1 声明式 adapter

`AgentAdapter` 只声明：

- executable、Terminal argv；
- `buildArgv()`；
- `jsonl` 或 `acp-json-rpc` 协议；
- `native-resume` 或 `transcript` 会话策略。

`registry.ts` 只组合 adapter。router、runtime、worktree manager 禁止出现
`switch(agentId)` 或同类 agent 特判。

### 5.2 三家结构化协议

- **Claude**：`claude -p --input-format stream-json --output-format stream-json
  --verbose --permission-mode bypassPermissions`。prompt 是一行 user JSON。
  `--include-partial-messages` 仅在 `claude -p --help` 探测支持时添加。捕获
  session id，后续使用 `--resume`。
- **Codex**：新回合使用 `codex exec --json ... -C <cwd>`；原始 prompt 写入
  stdin 后 EOF。捕获 thread id，后续使用 `codex exec resume --json ... <id>`。
- **Kimi**：启动 `kimi acp`，依次执行 `initialize → session/new →
  session/prompt`。处理 `session/update`、权限请求和 `session/cancel`。当前未用
  `session/load`，每轮以 bounded transcript 补历史。

三者都映射为 `AgentEvent`：assistant、thinking、tool start/end、usage、session、
turn complete、warning、error 和 process exited。

### 5.3 生命周期与持久化

- 同一 agent 同时只能有一个 structured run。
- 协议 `turn-complete` 后进入 finishing；收到进程 `close` 才真正释放 run。
- 仅 `exit code === 0`、协议已完成且没有 error 时，记录本轮 transcript/session。
- native resume 失败会清除旧 session id；下一轮用已完成 transcript 重建。
- 取消使用进程组 SIGTERM/SIGKILL；ACP 先发 `session/cancel`。
- 切换 base repo 时先 `await runtime.disposeAll()`，再清理 worktree/session。

### 5.4 Chat 与 Terminal 互斥

- structured run 活跃时不能打开同一 agent 的 Terminal；
- Terminal PTY 活跃时不能发起同一 agent 的 structured run；
- PTY 只承载原生 TUI，不参与默认 `@@` 路由和语义解析。

### 5.5 IPC

renderer → main：

- invoke：`agent:run`、`agent:cancel`、`agent:terminal:open`、
  `agent:terminal:close`；
- send：`agent:pty:input`、`agent:pty:resize`；
- repo/worktree：`repo:pick`、`repo:current`、`worktree:status`、
  `worktree:open`、`worktree:apply`。

main → renderer：

- `agent:event { target, event }`；
- `agent:pty:data { target, data }`。

preload 只通过 `contextBridge` 暴露上述受控 API；完整仓库路径不发送给 renderer。

## 6. 关键约定

- 面向用户的文案和文档用中文；代码、标识符、路径和提交信息用英文。
- 子进程使用 `spawn` / `execFileSync` 加参数数组，固定 `shell: false`；禁止拼 shell
  命令。
- vendor 差异只能进入 adapter/decoder/protocol driver，不能进入 router。
- 结构化事件必须来源于协议；推断事件不得驱动成功生命周期。
- SessionStore 只记录成功回合，历史最多 20 轮，每条消息最多 12,000 字符。
- 合并主仓库前 UI 二次确认，主仓库必须干净，只允许 `--ff-only`。
- 不要删除结构化 adapter、旧 transcript mapper 或 PTY；它们现在各有清晰职责。

## 7. 已知坑

1. **node-pty 原生 ABI**：重装依赖后必须 `npm run rebuild:native`。npm 11
   `allow-scripts` 可能拦截 electron/esbuild/node-pty 安装脚本。
2. **Claude partial flag 不是所有版本都有**：必须保留 help capability gate；没有
   partial 时 decoder 仍需接受完整 assistant/result 事件。
3. **Claude stream-json stdin 不能过早 EOF**：写入首条 user JSON 后保持打开，
   收到 terminal turn 后再关闭；否则可能截断工具链或 result。
4. **不要把 `turn-complete` 当作进程已退出**：UI/Terminal/worktree 清理必须以
   `process-exited`/`finished` 为边界。
5. **Codex resume argv 与 fresh argv 不对称**：当前 resume 子命令不带 `-C`；
   child 本身已在 worktree cwd 启动。用户环境的代理可能导致网络重试。
6. **Kimi ACP 是有状态握手**：每个阶段都有 watchdog；权限请求需回 JSON-RPC
   response；取消优先 `session/cancel`，再由信号兜底。
7. **PTY 与 structured run 必须互斥**：否则两个 agent 进程会同时修改同一个
   worktree。
8. **Electron main 是 CJS**：`__dirname` 可用；不要通过 `"type":"module"` 处理
   Vitest 的 Vite config warning。
9. **真实 CLI 测试有成本且依赖本机鉴权/代理**：默认 skip，交付前明确记录是否跑过。

## 8. 代码地图

```text
src/main/
  index.ts                     Electron 生命周期
  app-identity.ts              Agent Squad HQ 身份、环境兼容与启动前数据迁移
  ipc.ts                       IPC 与服务总编排
  agent-runtime.ts             run 独占、会话恢复、成功持久化
  run-manager.ts               每 turn 子进程、stdio、取消、退出边界
  session-store.ts             native session + bounded transcript
  pty-manager.ts               显式 Terminal 的 node-pty
  worktree-manager.ts          worktree/status/apply
  adapters/
    contract.ts                声明式 adapter 与 AgentEvent 合同
    registry.ts                adapter 组合（禁 agent 特判）
    claude/{adapter,decode}.ts  Claude stream-json
    codex/{adapter,decode}.ts   Codex JSONL
    kimi/adapter.ts             Kimi ACP runtime 定义
    shared/                     executable discovery、capability probe、JSONL buffer
  protocols/acp-session.ts     ACP JSON-RPC driver
src/preload/index.ts           contextBridge API
src/renderer/src/
  App.tsx                      ProjectShell 入口（Phase 1 起替换旧三槽 UI）
  project-shell.tsx            Project Shell 组件 + useWorkbench hook
  workbench/
    contract.ts                WorkbenchPort 合同（品牌化 ID、ViewModel、Command、Event）
    mock-scenario-adapter.ts   MockScenarioAdapter（in-memory port 实现）
    standard-scenario.ts       标准场景数据
  chat-state.ts                纯事件 reducer（v0.1 保留，Phase 1 不再渲染）
docs/
  PLAN-v0.2.md                  当前产品与工程路线
  UX-v0.2.md                    当前信息架构、流程与状态
  design/                       throwaway A/B 原型与评审说明
  adr/0007-*.md                结构化 Chat / PTY 通道决策
  adr/0008-*.md                Project-first / Agent Instance 决策
  adr/0009-*.md                指挥中心布局、显式执行与生命周期
  adr/0010-*.md                飞书集成信任边界与数据主权
  adr/0011-*.md                生产 UI-first 与契约化 mock 顺序
  adr/0012-*.md                强制执行门禁与受控 Connector 能力
  research/open-design-*.md    迁移依据
CONTEXT.md                      Project、Agent、Tab、Panel 领域词汇
```

## 9. 下一步

Design Gate 已关闭，冻结结果是”指挥中心 A 主骨架 + B 态势抽屉 + C Focus/窄窗口
palette”和”Settings A 完整编辑器 + B 比较视图 + C readiness 摘要”。Phase 1 #1 已完成
（[PR #18](https://github.com/pcliangx/agent-squad-hq/pull/18)：Project Shell + 版本化
WorkbenchPort + MockScenarioAdapter）；剩余 #2–#16 按 GitHub Relationships 的原生
`blocked by` 处理 frontier。#1–#16 的理论关键路径为 7 批、最大并行度为 4；Issue 正文、
labels、comments、状态和依赖只以 GitHub 为 truth。共享工作树默认仍按本仓库协作协议串行
接力，只有分配独立 worktree 与清晰边界后才并行。

[产品身份迁移 #17](https://github.com/pcliangx/agent-squad-hq/issues/17) 已完成并关闭；
#1 已由 [PR #18](https://github.com/pcliangx/agent-squad-hq/pull/18) 实现。

第一生产阶段只做契约驱动 UI 与 MockScenarioAdapter，不能先实现真实 ProjectStore、
Agent/PTY、Git mutation、PermissionBroker 或飞书副作用。当前代码的 `AgentId` 实际是
ProviderId，迁移必须将它与 AgentInstanceId 分开；当前 v0.1 的 Claude
`bypassPermissions` 与 Kimi 自动允许只是既有安全缺口，不能被描述为 v0.2 的有效权限。
Phase 3 在最小 PermissionBroker 就绪前禁止启动真实 Run。不要实现外部事件或 assistant
普通文本自动触发 Agent。

## 10. 交付纪律

提交前必跑：

```bash
npm run typecheck && npm test && npm run build
```

另外执行 `git diff --check`。真实 CLI E2E 与 Electron GUI 冒烟不能假装已自动完成；
未运行时在交付说明中明确标注。
