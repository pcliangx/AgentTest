# AgentTest — 交接文档（给 Codex）

> 交接日期：2026-07-31　·　最新提交：`a2b02bb`　·　分支：`main`（已推送 origin）
> 这份文档面向接手继续开发的 AI/人。读完它 + 跑一次 `npm run dev` 就能上手。

## 1. 这是什么

一个 **Electron 桌面壳**，嵌入三个编码 agent CLI（**Claude Code / Codex CLI / Kimi Code**）：

- 统一输入栏用 `@@` 路由（`@@claude` / `@@codex` / `@@kimi` / `@@all`），无 `@@` 不派发；
- 每个 agent 一个**常驻 PTY**（`node-pty` + `xterm.js`），跑各自的**原生交互式 TUI**——流式、暖进程、即时 follow-up；
- 每 agent 跑在一个**隔离的 git worktree**（基于用户选的仓库），互不踩；
- **transcript 旁路**：tail claude 的会话日志，提供结构化数据（token / 回合状态 / 工具）显示在 pane 标题栏；
- **改动视图**：每 pane 可查看该 worktree 改了哪些文件，并「合并到主仓库」（fast-forward）。

## 2. 当前状态（已完成）

| 能力 | 状态 |
|---|---|
| 脚手架（electron-vite + React + TS + Tailwind v4） | ✅ |
| `@@` 路由 + 三 pane（xterm） | ✅ |
| PTY 长驻（claude/codex/kimi 交互式 TUI） | ✅（codex/kimi 仅 claude 经人肉确认；见 §8） |
| worktree 隔离 + RepoPicker（打开真实仓库） | ✅ |
| claude transcript 旁路（结构化元数据） | ✅ |
| 改动视图（git status/diff）+ 合并到主仓库（ff-only） | ✅ |
| 结构化 adapter（模型一，一击+resume，claude） | ✅ 但**已休眠**（见 §6） |

提交链：`0bba951`→`24a4692`→`f144c18`→`172db7d`→`27c3450`→`6a5dd09`→`c9ed9b6`→`2c264aa`→`c76cee6`→`a2b02bb`。

## 3. 先读这些（按顺序）

1. **本文档**。
2. `docs/adr/0006-v0.1-pty-primary.md` —— **当前架构决策**（PTY 为主通道）。
3. `docs/PLAN-v0.1.md` —— 原始规划；注意其"方案 B 结构化 / 模型一"已被 **ADR-0006 修订**为 PTY 为主，仅作背景。
4. `src/main/adapters/PROBE.md` —— 三家 CLI 的真实调用参数、事件 schema、跨切面坑。
5. `agent-adapter-architecture.md`（仓库根）—— 原始调研，Adapter 设计的背景思想。

## 4. 技术栈与命令

- Electron + `electron-vite`（main/preload 走 CJS；**无** `"type":"module"`）+ React 19 + TypeScript **7** + Tailwind **v4**（`@tailwindcss/vite`，CSS 用 `@import "tailwindcss"`）+ `vitest` + `node-pty`（原生）+ `@xterm/xterm`。

```bash
npm run dev            # 起 Electron 开发（会打开窗口）
npm run build          # electron-vite 打包 main/preload/renderer
npm run typecheck      # tsc 两套配置（node + web）
npm test               # vitest 单测（e2e 默认 skip）
AGENTTEST_E2E=1 npx vitest run <file>   # 跑真实 CLI 的 e2e（会花额度）
npm run rebuild:native # 重编 node-pty 对齐 Electron ABI（重装 node_modules 后必跑）
```

- npm registry 走 npmmirror；装依赖用 `--legacy-peer-deps`（Vite/Electron peer 严格解析会冲突）。
- **GUI 流程无法在 agent 内驱动**：typecheck/build/test 能自动验；渲染/对话框/合并按钮要**人肉跑 `npm run dev` 验**。

## 5. 架构（当前）

**双通道**：
- **PTY**（主）：`PtyManager` 每 agent 一个长驻 `node-pty` 进程，跑交互式 TUI；字节流 → `agent:pty:data` → renderer 的 xterm。`@@` 路由 = 往目标 PTY 写 `text\r`；也支持直接在终端打字。
- **transcript 旁路**（claude）：`TranscriptWatcher` 轮询 tail `~/.claude/projects/<编码cwd>/<sid>.jsonl` → 解析成结构化事件 → `agent:transcript:event` → pane 标题栏显示 token/状态/工具。

**IPC 通道**（`src/main/ipc.ts`）：
- renderer→main（send）：`agent:run {target,text}`、`agent:pty:input {target,data}`、`agent:pty:resize {target,cols,rows}`
- main→renderer（send）：`agent:pty:data {target,data}`、`agent:transcript:event {target,event}`、`agent:error {target,message}`
- invoke（请求/响应）：`repo:pick`、`repo:current`、`worktree:status {target}`、`worktree:open {target}`、`worktree:apply {target}`

**worktree 隔离**：`WorktreeManager` 每 agent 一个 `git worktree add --detach`，基于 `SettingsStore` 选中的 base repo（`getDefaultBaseRepo()`）。`@@all` → 三家各自 worktree 独立改。

**进程分工**：main（Node）= PTY/git/adapter/持久化/IPC；preload = `contextBridge`（只暴露受控 API）；renderer（React）= xterm + 输入栏 + 弹窗。

## 6. 关键约定（务必遵守）

- **语言**：面向用户的文案/文档用**中文**；代码、标识符、路径、commit 信息用**英文**。
- **registry/router 禁止 `switch(agentId)`**（见 `adapters/contract.ts`、`registry.ts` 注释；原始调研 §2/§13）。新增 adapter 不应改 router/run-manager。
- **结构化代码（模型一）保留但休眠**：`run-manager.ts`、`adapters/claude/{adapter,decode}.ts`、`session-store.ts`、`registry.ts` 当前不在主流程（PTY 接管），但已测、保留作未来 model-2 双向（ADR-0005）或元数据旁路复用。**别删。**
- **CJS main**：`__dirname` 可用；别加 `"type":"module"`（会破坏 Electron main）。electron-vite 自动外部化 `dependencies`（node-pty 不打进 bundle）。
- **TS7**：`moduleResolution: "Node"` 与 `baseUrl` 已被移除——用 `"Bundler"`、别用 `baseUrl`。

## 7. 安全约定

- **子进程一律用 `execFileSync`/`spawn` + 参数数组**，禁止 `exec` 拼字符串（防注入；见 `worktree-manager.ts`、`discover.ts`、`ipc.ts` 的 `isGitRepo`）。
- **只把仓库名（basename）回传 renderer**，完整路径留在 main。
- 合并主仓库前 UI 二次确认 + 前置"主仓库须干净"+ 仅 `--ff-only`（失败即 `merge --abort`，不留半状态）。

## 8. 已知坑（每个都耗过真实时间，务必看）

1. **node-pty 是原生模块**：`rm -rf node_modules` 重装后必须 `npm run rebuild:native`（`electron-rebuild` 按 Electron ABI 编译）。`allow-scripts`（npm 11 安全特性）会拦 postinstall——`esbuild`、`electron`、`node-pty`、`fsevents` 的 install 脚本被拦，需手动跑（esbuild: `node node_modules/esbuild/install.js`；electron: 带 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 跑 install）。
2. **claude transcript 路径**：claude 用 **realpath** 命名 projects 目录——macOS 上 `/var`→`/private/var`，必须 `realpathSync(cwd)` 再编码（`ipc.ts` 的 `ensureTranscript` 已做）。
3. **claude 目录编码**：每个**非字母数字**字符 → `-`（含下划线、空格、`/`），见 `transcribe.ts` 的 `claudeProjectDir`。早期只替换 `/\:空格` 漏了 `_`，e2e 逼出来。
4. **transcript 落盘时机**：交互式 claude 在**一个 turn 完成后**才写 transcript（启动/被早期 kill 时不写）。`-p` 模式也按 turn。watcher 要容忍文件晚出现 + 最后一行可能**无结尾换行**（`transcript-watcher.ts` 已处理残余 buffer）。
5. **`-p` transcript 没有 `system` 记录**：session id 从 `user` 记录取（`transcribe.ts`）。
6. **交互式 claude 调用**：`-p --output-format stream-json --verbose --bare`；`--verbose` 是 stream-json 在 print 模式的硬性要求，`--bare` 跳过 hooks/LSP/plugins（消除配置继承噪声、还更快）。
7. **git push 走 HTTPS**：用户全局有 `url.https://github.com/.insteadof git@github.com:`，`git@github.com:` 会被改写成 HTTPS。符合既有配置，别强改 SSH。
8. **npm `tail` 掩盖退出码**：typecheck 用 `set -o pipefail` 包住管道，否则失败被 `tail` 吞掉。

## 9. 还没做 / 下一步（挑一个开干）

按价值排序：

1. **codex/kimi transcript 旁路**：probe 它俩的会话日志（`~/.codex/sessions/`、`~/.kimi-code/`），写各自的 `mapXxxTranscript` + projectDir 解析，在 `ensureTranscript` 里按 agent 分派。让三个 pane 都有 token/状态。
2. **确认 codex/kimi 在 app 里真能跑**：目前只 claude 经人肉确认。`@@codex 你好`/`@@kimi 你好` 试；codex 之前 `exec` 模式有网络重试（见 PROBE.md），交互式可能不同。
3. **对比视图**：并排 diff 两个 agent 的 worktree（竞技场核心体验）。
4. **UX**：Split（并排）/Focus（Tab）切换（ADR 里的 A+C）、每 pane「重启 agent」、改动文件数实时显示。
5. **model-2 duplex**（ADR-0005，延后）：claude `--input-format stream-json` 双向，解锁 mid-run steer/中断——但失去原生 TUI。

## 10. 代码地图

```
src/main/
  index.ts              app 生命周期 + initServices + registerIpc
  ipc.ts                IPC 总编排（PTY/ transcript/ repo/ worktree）★改交互先看这
  pty-manager.ts        每 agent 长驻 PTY（node-pty）
  worktree-manager.ts   git worktree 增删 + status + applyToBase（合并）
  transcript-watcher.ts 轮询 tail 会话日志（通用）
  workspace.ts          base repo 解析（用户选 > env > 临时空仓）
  settings.ts           持久化 base repo
  run-manager.ts        【休眠】结构化一击 spawn（model-2 复用）
  adapters/
    contract.ts         AgentAdapter / AgentEvent 类型
    registry.ts         组合 adapter（禁 switch）
    PROBE.md            三家 CLI 调用与 schema 笔记
    claude/{adapter,decode,transcribe}.ts  结构化 adapter + transcript mapper
    claude/*.test.ts    单测 + e2e（AGENTTEST_E2E=1）
    shared/{bounded-jsonl-decoder,discover}.ts
src/preload/index.ts    contextBridge 受控 API + 类型
src/renderer/           React + xterm + 输入栏 + 改动弹窗（App.tsx）
docs/                   PLAN-v0.1.md、adr/0001..0006、（本 HANDOFF.md）
```

## 11. 工作纪律（怎么接手不翻车）

- 改代码后、提交前必跑：`npm run typecheck && npm test && npm run build`（用 `set -o pipefail`）。
- 真实 CLI 的验证写 e2e（`describe.skipIf(!process.env.AGENTTEST_E2E)`），默认 skip 不烧额度。
- **GUI 流程要人肉验**：agent 内无法驱动 Electron 窗口——交付时如实标注"待手动验"。
- commit 信息：`type: 简述`（feat/fix/docs），结尾加 `Co-Authored-By:` 行（本项目用 `Claude Fable 5 <noreply@anthropic.com>`；Codex 接手可换自己的）。
- 方向性决策（如换通道/改 ADR）写进 `docs/adr/`，别悄悄掉头。
