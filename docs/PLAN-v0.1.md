# AgentTest v0.1 规划

> 状态：草案（已与产品负责人达成共识，2026-07-31）
> 关联：[agent-adapter-architecture.md](../agent-adapter-architecture.md)（Adapter 设计参考）、[docs/adr/](./adr/)（决策记录）
> 适用范围：嵌入 Claude Code / Codex / Kimi Code 三个编码 agent CLI 的 Electron 桌面壳

## 1. 共识（已锁定的决策）

| # | 决策点 | 选择 |
|---|---|---|
| 1 | 形态 | 独立 Electron 桌面应用，与 `Agents-Fleet_bak` 无关 |
| 2 | 消息模式 | 模式 3：广播 + 单发 |
| 3 | 路由 | `@@` 显式（`@@claude` / `@@codex` / `@@kimi` / `@@all`），无 `@@` 不派发 |
| 4 | 通道 | 方案 B：结构化优先（stream-json） |
| 5 | 会话模型 | **v0.1 模型一**：一次性 exec + 原生 resume；模型二（duplex）延后 |
| 6 | 工作区 | B：每 agent 一个 git worktree（同基线、各自改动） |
| 7 | 权限 | A：worktree 内 YOLO / auto-approve |
| 8 | 技术栈 | React + electron-vite + TypeScript + Tailwind |
| 9 | UI 布局 | A+C：Split（并排）/ Focus（Tab）可切 |

详见 [docs/adr/](./adr/)。

## 2. v0.1 范围

**做（In）**：3 个 adapter（模型一）、`@@` 路由、`@@all` 广播、worktree 隔离、YOLO、Split/Focus UI、session resume、transcript 落盘。

**不做（Out，延后）**：模型二 duplex、mid-run steer / 中断、结构化权限审批 UI、动态加载第三方 adapter、共享 server、MCP 作传输、node-pty / xterm（模型一非交互，不需要）。

## 3. 架构总览

```
输入栏 (@@claude / @@all)
   │  IPC: sendMessage
   ▼
Main · MessageRouter        ← 解析 @@，展开成目标 agent 列表（无 @@ → 拒绝）
   │  每个目标 agent 一条
   ▼
RunManager ──► WorktreeManager.ensureWorktree(baseRepo, agent)   ← 统一建 worktree，不按 agent 名分支
   │
   ▼
AgentAdapter.buildResumeArgv / buildStartArgv  (+ autoApproveFlags)
   │
   ▼
child_process.spawn(executable, argv, { cwd: worktree, env })   ← 非交互，无 PTY
   │  stdout 流
   ▼
AgentAdapter.decode(chunk) → AgentEvent[]
   │  extractSessionId → SessionStore
   ▼  IPC: 推事件流
Renderer · AgentPane（Split 并排 / Focus 单列）
```

**进程分工**：
- **main（Node）**：spawn 子进程、git worktree、adapter registry、session/transcript 持久化、run 生命周期。
- **preload**：contextBridge 暴露受控 IPC API。
- **renderer（React）**：面板与结构化事件渲染、`@@` 输入。

## 4. 代码结构

```
agenttest/
├─ electron.vite.config.ts
├─ src/
│  ├─ main/
│  │  ├─ index.ts                 # app/window 生命周期
│  │  ├─ ipc.ts                   # IPC handler
│  │  ├─ router.ts                # @@ 解析 + MessageRouter
│  │  ├─ run-manager.ts           # 单次 run：spawn → stream → exit
│  │  ├─ worktree-manager.ts      # git worktree 增删（统一，不按 agent 名分支）
│  │  ├─ session-store.ts         # nativeSessionId + transcript 持久化
│  │  └─ adapters/
│  │     ├─ contract.ts           # AgentAdapter 接口 + AgentEvent 类型
│  │     ├─ registry.ts           # 组合，无 switch(agentId)
│  │     ├─ shared/bounded-jsonl-decoder.ts
│  │     ├─ claude/{adapter,decode}.ts + fixtures/
│  │     ├─ codex/…
│  │     └─ kimi/…
│  ├─ preload/index.ts            # contextBridge API
│  └─ renderer/                   # React + Tailwind
│     ├─ App.tsx
│     ├─ components/{InputBar,PaneStack,AgentPane,EventView,RepoPicker}.tsx
│     └─ ipc.ts
└─ docs/{adr/, agents/}
```

## 5. 核心抽象（精简版，对齐 architecture 文档 §6 但砍到 v0.1 够用）

```ts
// src/main/adapters/contract.ts
export type AgentId = 'claude' | 'codex' | 'kimi';

export interface AgentEvent {
  kind:
    | 'assistant-text' | 'tool-start' | 'tool-end'
    | 'usage' | 'turn-complete'
    | 'session-identified' | 'warning' | 'error' | 'process-exited';
  occurredAt: number;
  source: 'protocol' | 'inferred';   // 任何非协议直出的事实永远标 inferred
  payload: unknown;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly executable: string;
  readonly autoApproveFlags: readonly string[];          // 如 ['--dangerously-skip-permissions']
  buildStartArgv(input: { text: string }): readonly string[];
  buildResumeArgv(input: { text: string; nativeSessionId: string }): readonly string[];
  decode(chunk: Buffer): readonly AgentEvent[];          // 增量、有界
  extractSessionId(events: readonly AgentEvent[]): string | null;
}
```

`registry.ts` 只做组合，**禁止出现 `switch (agentId)`**（architecture 文档 §2 / §13 的核心约束）。新增第四个 adapter 不应修改 router / run-manager / worktree-manager。

## 6. 端到端：一条 `@@` 消息的生命周期

1. 输入 `@@claude 给我加个测试` → renderer 解析目标，IPC `sendMessage({ targets: ['claude'], text })`
2. main：`ensureWorktree(baseRepo, 'claude')`（已存在则复用）
3. adapter：有 nativeSessionId → `buildResumeArgv`，否则 `buildStartArgv`，拼上 `autoApproveFlags`
4. `spawn(claude, ['-p', text, '--output-format', 'stream-json', '--dangerously-skip-permissions', ...], { cwd: worktree })`
5. stdout 流 → `decode` → `AgentEvent[]` → IPC → 该 agent 的 pane
6. `session-identified` → SessionStore 存 `nativeSessionId`；`process-exited` → run 收尾
7. `@@all` = 步骤 2–6 对三家**并发**，各进各的列，**互不阻塞**（一家失败不影响另两家）

## 7. 实施阶段（Claude-first，对齐 architecture 文档 §15）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **0 脚手架** | electron-vite + React + TS + Tailwind；main/preload/renderer 全链路；dummy spawn 验证 IPC | 输入 → IPC → spawn → 回流 → pane 渲染 |
| **1 Claude 单链路** | Claude adapter（模型一）+ decoder(fixture) + WorktreeManager(单) + SessionStore | `@@claude` 跑完 → 事件渲染 → 第二条 `--resume` 接上。**固化接口** |
| **2 第二 adapter + 广播** | 加 Codex 或 Kimi（先做 stream-json schema 更清晰的）**验证 seam**；`@@all` 并发；PaneStack Split | `@@all` 两家并排、各自 worktree、互不阻塞。**不改 router 的 agent 特例** |
| **3 第三 adapter** | 补齐三连 | 三家并排对比成型 |
| **4 UX 收尾** | Split/Focus 切换、`@@` 补全、usage/turn 渲染、错误/停止(kill)、RepoPicker、transcript 回放 | 可日常使用 |
| **5（后续）模型二** | 按 [ADR-0005](./adr/0005-future-duplex-upgrade.md)：Claude(Agent SDK 双向) → Kimi(ACP) → Codex(app-server 待稳定) | 解锁 steer / 中断 / 低延迟 |

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| `--resume` 不真能恢复完整上下文（architecture 文档 §3 / §16） | 每 adapter 先 probe + 脱敏 fixture；不可靠则降级为"每条全新 run"并如实标注 |
| stream-json schema 各家不同、随版本漂移 | 每 adapter 独立 decoder + 版本 pin + fixture diff（§14） |
| stdout 混入非 JSON / 超大帧 / 半帧 | 有界 JSONL decoder，非 JSON 行跳过 / 标 warning（§7.1 / §14） |
| YOLO：agent 跑的 shell 命令在本机真实执行 | worktree 隔离文件层；文档化命令执行风险；远期给 Claude/Kimi 套可选沙箱 |
| 一次性模式无法 mid-run steer / 中断 | v0.1 接受；"停止" = kill 进程；steer / 中断留给模型二 |

## 9. 决策记录索引（ADR）

- [ADR-0001](./adr/0001-v0.1-oneshot-resume-model.md) — v0.1 采用模型一（一次性 + resume），模型二延后
- [ADR-0002](./adr/0002-per-agent-git-worktree.md) — 每 agent 一个 git worktree 隔离
- [ADR-0003](./adr/0003-yolo-auto-approve-per-worktree.md) — worktree 内 YOLO / auto-approve
- [ADR-0004](./adr/0004-at-at-explicit-routing.md) — `@@` 显式路由，无隐式广播
- [ADR-0005](./adr/0005-future-duplex-upgrade.md) —（未来）模型二 duplex 升级路径

## 10. 下一步

按阶段推进：Phase 0（脚手架）→ Phase 1（Claude 单链路）→ …。每个 adapter 落地前先做该 agent 的 stream-json schema + resume 行为 probe，并保留脱敏 fixture。
