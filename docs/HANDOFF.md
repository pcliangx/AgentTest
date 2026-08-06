# Agent Squad HQ — Claude Code / Codex 续开发文档

> 更新日期：2026-08-04 · 结构化通道基线：`ba49614` · 分支：`main`
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
| Phase 1 #1 Project Shell + WorkbenchPort + MockScenarioAdapter | ✅ [PR #18](https://github.com/pcliangx/agent-squad-hq/pull/18) |
| Phase 1 #2 全局 Connections/Provider Health/确认宿主 | ✅ [PR #19](https://github.com/pcliangx/agent-squad-hq/pull/19) |
| Phase 1 #9 Permission Center 与 Global Attention | ✅ 已合入 main |
| Phase 1 #14 策略矩阵、Readiness 与降级安全状态 | ✅ 见 [Issue #14](https://github.com/pcliangx/agent-squad-hq/issues/14)；其余 #3–#16 按 frontier 推进 |
| UI 视觉对齐 #65 设计令牌与应用壳 | ✅ 已合入 main（[PR #70](https://github.com/pcliangx/agent-squad-hq/pull/70)）：@theme 亮色令牌、`@layer components` 共享类、全局 StatusDot、38px 自定义 titlebar、82px 图标导航与 statusbar；context pane 属 #66 |
| UI 视觉对齐 #66 固定上下文目录栏与 Agent Directory | ✅ 已合入 main（[PR #71](https://github.com/pcliangx/agent-squad-hq/pull/71)）：244px context pane（`raised` 背景 + `line` 右边框）常驻全部 Project surface；项目切换卡、需要处理/全部实例分组（去重枚举）、31px provider-code avatar、运行摘要 footer；Agents surface 内部目录列与此共用同一组件 |
| UI 视觉对齐 #67 工作区 Panel/Tab chrome 与 Agent 视图 | ✅ 已合入 main（[PR #72](https://github.com/pcliangx/agent-squad-hq/pull/72)）：Panel 白卡 + P 序号 + Focus 品牌描边（`shadow-panel`/`shadow-panel-focus`）、Tab strip（StatusDot + 名称 + 关闭）、统一 mini-button 面板工具条、Agent 头卡（avatar + Provider·独立 worktree + 状态 pill）与下划线分段导航；契约新增 adapter 所有的 `chatEntries`/`currentTaskSummary`，Chat 渲染当前任务块、mono tool chip 与 per-Panel composer（`只发送给 <name>…` + 品牌圆形发送钮）；4+ Panel 溢出滚动下沉到最内层 split 容器 |
| UI 视觉对齐 #68 Settings 层级配置台与运行雷达态势抽屉 | ✅ 已合入 main（[PR #73](https://github.com/pcliangx/agent-squad-hq/pull/73)）：Settings A 改为顶部 放弃全部变更/应用全部变更 操作条 + 238px 图标目录栏（段描述 + Agent Instances 列表，provider-code avatar + StatusDot 替代 `选择实例` 下拉）+ 分区表单卡（身份与运行配置/工作区与进程/实例环境，readonly 控件 + Doctor 徽标）+ 常驻 待应用修改·N 摘要栏；策略矩阵改为白卡表格（表头 readiness pill、行 timing 小注、横向滚动不截断 + 琥珀提示条）；Readiness 改为四张状态卡（Provider readiness/Workspace isolation/Feishu trust boundary/Run policy）+ 逐实例卡 + 配置生效边界卡；Global Attention 抽屉按雷达重组（需要处理=权限卡片优先、运行中与排队、最近完成 agent 行 28px avatar + StatusDot）+ 头部容量行（`全局 y/6 · Project x/3`，新增 `project` prop）；集成徽章改为复述 applied 主连接的 adapter 状态（新增共享 `connection-display.ts` 的 `CONNECTION_STATUS_LABEL`，review 修正：绑定存在不再冒充已连接）；draft/apply/discard 原子语义与深链、焦点、Escape 行为不变；原型 toggle 开关无数据支撑（目录无布尔字段）不渲染，原型 Base drift/项目默认网络/资源计数行同样省略 |
| UI 视觉对齐 #69 其余工作面统一与视觉验收门禁 | ✅ 已合并（PR #74）：新增共享 `status-chip.tsx`（非 Agent 状态徽章唯一组件，颜色+装饰图标+文案三编码，tone=neutral/brand/good/warn/danger，`index.css` 新增 `.chip-danger`）并接入 Tasks（同步/评审/业务/本地/dispatch 生命周期/tombstone 状态，统一走 `DISPATCH_STATUS_CHIP` 等 Record 映射）、Knowledge（容器状态）、Handoffs（完整度/验证/导入/来源）、Activity（16 种 kind 经 `ACTIVITY_KIND_CHIP`）、Connections、Provider Health；Overview 改四张大数字统计卡（label 在上、数字在下，对齐冻结基线）+ 状态卡（根目录/Git/连接 StatusChip 行）+ 最近活动卡，一级动作 派发给 Agent btn-primary；Activity 改卡片分行；Provider Health 补模型行；Global Settings 从「尚未实现」占位改为 运行容量卡（`global.concurrency` 事实）+ 演示模式提示；PlaceholderSurface 及其挂载分支删除（7 个 Project surface 全覆盖，「尚未实现」文案绝迹）；Dispatch Picker 目标行加 24px avatar + 装饰 StatusDot、已选目标 chip 品牌化（不可派发 amber ⚠）；新增 `tests/ui/visual-artifacts.spec.ts` 视觉捕获门禁（`npm run capture:visual` 一条命令产出 12 张 1280×800 全套工作面截图到 `test-results/visual/`，同时并入 test:ui 默认运行）；原型比对确认：三个全局工作面无原型区域（以 token 一致性验收），原型 同步/筛选/导出/详情/进入工作区/重新生成 dirty Agent 按钮无 contract 命令不渲染，Knowledge 模拟飞书页面按 Phase-1 边界不复刻 |
| 顶部常驻项目快捷切换条 #75 | ✅ 已合并（PR #81）：新增 `project-switch-bar.tsx`——全局入口组（连接/Provider 健康/全局设置）+ 每 Project 一个按钮，同一 header 常驻全部界面，任何目标一步直达；溢出按镜像行（真实 `<button>`、真实字重与文案）测量 + ResizeObserver 收进键盘可操作的「更多」菜单（方向键双向环绕/Home/End/Escape/Tab，激活或 Escape 焦点归还 trigger）；当前项字重+底色+`aria-current` 三编码，当前项目折入菜单时由关闭态 trigger 承载（菜单打开后让位给 menuitem）；目录栏「切换项目」下拉改为静态项目身份卡（名称 + rootPath 保留），「← 返回项目」移除；切换语义不变（`navigate(targetId, currentSurface)`），无契约改动；视觉门禁新增 13/14 切换条截图并断言项目/全局视图间 x/y/height 不跳动。**#76 更新**：全局入口从切换条移入左导航 App 层，切换条回归纯 Projects |
| App 级首页与双层左侧导航 #76 | ✅ 已合并（PR #82）：新增 `home-surface.tsx`（品牌区 + 快速建项目卡 [项目名 + 根目录，双字段必填] + 最近项目卡 [按 `lastOpenedAt` 倒序，名称/路径/本地化时间，点击直达]）；契约新增 `GlobalSurface 'home'` + `create-project` 命令（adapter 演示实现：建仓即进入、空 Panel、`repositoryReadiness: 'not-ready'`）+ `ProjectViewModel.lastOpenedAt`（adapter 在**进入**项目时打戳——从首页/其他项目/全局工作面返回均算，项目内切 surface 不刷新）；左导航改为双层：App 级四项（首页/连接/Provider 健康/全局设置，`role="group" aria-label="App 级"`）在上、项目 7 工作面在下，header 全局按钮移除；切换条回归纯 Projects（`onSwitchProject` 与首页 `onOpenProject` 共享 `openProject` 回调）；启动落在首页；视觉门禁新增 `01-home` 截图，全套 01–15 |
| 工作区 Tab 指针拖拽 #77 | ✅ 已合并（PR #83）：`move-tab` 契约最小扩展 `insertionIndex?: number`（省略时行为不变），reducer 支持同面板重排（含 no-op 检测 + 越界 clamp）与跨面板按索引插入；标签条成为拖放目标——`computeTabInsertionIndex` 按指针 X 相对各 Tab 中心计算插入索引，`.tab-insertion-indicator`（2px 品牌竖线）+ `.tab-strip-drop-target`（品牌色 + inset 底环，形状+颜色双编码 §15）反馈；tablist `z-20` 置于 split-zone 覆盖层之上；键盘等效 `Alt+ArrowLeft/Right` 条内重排（§15 非指针替代）；`insertTabAtIndex` + `selectAndFocus` 消除 reducer 重复；smoke 补条内排序 `dragTo` + 跨 Panel 拖拽步骤 |
| Agent 实例关闭（归档）与只读 transcript #78 | ✅ 已合并（PR #84）：契约新增 `archive-instance` / `restore-instance`（mock 先行）；adapter 归档中断 Run、清队列、消除 Attention、保留 transcript；重开恢复 `ready` 且历史不丢；归档走共享高危确认宿主（动态 impact 文案：中断/清队列/Attention 消除）；Agent Directory 行加 ✕ 关闭按钮；归档 Panel 顶部品牌色 notice 条（🔒 + border + 文案 §15）+「重开实例」按钮 + 隐藏输入区；smoke 补归档/只读/重开路径 |
| Provider 品牌图标 #79 | ✅ 已合并（PR #85 + #86）：新增 `provider-icon.tsx` 共享组件——`PROVIDER_ICON_CONFIG` Record + `MARKS` map 查表，原创 SVG 几何标记（Claude Code 珊瑚橙星爆 / Codex 近黑六边形纽结 / Kimi Code 深蓝新月 / Gemini CLI teal 宝石）+ 品牌色入 `@theme` 令牌；全量替换 5 处头像位；未知 Provider 降级为现有 mono 首字母块；图标 aria-hidden 不随状态变化，StatusDot 纪律不变；无契约改动 |
| Settings 模型与提供商 #80 | ✅ 已合并（PR #87）：契约新增 `rescan-providers` / `test-provider` / `enable-provider` + 3 个 `ActivityKind`；provider VM 增补 `version` / `modelSource` / `installState` / `enabled` / `installCommand` / `vendorDescription`；Settings 新分区「模型与提供商」——检测 CLI 卡片（ProviderIcon + 厂商 + 版本 + 模型来源 + 测试/接入）+ 重新扫描 + 可安装折叠区（复制安装命令不代执行）；New Agent + Provider Health 按 `enabled` 过滤；标准场景新增 Aider（installed+not-enabled）+ Qwen Coder（installable） |
| UIUX 视觉刷新 #88 | ✅ 已合并（PR #89）：全局字号体系刷新（body 13px/1.5，共享类 btn 12/chip 10/section-label 11，零 8/9px 残留）+ 圆角统一（零硬编码 `rounded-[px]` → xl/lg/md）+ `--shadow-card`/`--shadow-card-hover` 阴影体系；首页品牌渐变 hero + 项目卡片（渐变缩略色块 + Git/Run 摘要 + ⚙ 设置快捷操作）；对话区气泡化（用户品牌蓝 / Agent 白卡）+ mock markdown（代码围栏/行内代码/粗体/列表）+ tool call 分类状态卡片；Agent 头卡品牌色渐变 + ready teal pill；titlebar 品牌渐变 accent；loading skeleton；tab 切换 keyed fade-in；全局 120ms transition + hover 浮起 + active 按压；各面卡片质感统一（tasks/knowledge/handoffs/connections/provider-health/settings） |
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
4. [UX-v0.2](./UX-v0.2.md)；设计基线已冻结；Phase 1 #1–#2 已完成，其余 tickets 尚未启动。
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
npm run test:ui
npm run check:release

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

### 5.5 Dispatch 规划合同

- Picker、`@@all` 和 Agent Composer 通过 `WorkbenchPort.planDispatch()` 获取
  revision 绑定的只读计划，不在 renderer 内推断容量或队位；
- planner 以活动 runtime state 为容量 truth，严格按目标顺序虚拟占用 Project/
  Global 容量，并给入队项分配唯一的 Project-scoped position；
- 查询不修改 snapshot、不增加 revision、不创建业务 ID、不发事件，也不预留容量；
- 确认命令显式携带计划 revision，adapter 在相同 revision 下用同一 planner 原子
  执行；状态变化后必须 `stale-revision`，不能静默按新状态重算；
- `reply-current-run` 不是新 Run，不需要 Dispatch plan。

### 5.6 Layout 目标结果合同

布局命令，以及在当前/新 Panel 打开的 `create-agent`，其成功 `CommandResult` 可携带由
唯一 Layout reducer 生成的 `layoutTargetEffect`（选择 Agent，或关闭 Agent 及其后继
选择）。renderer 按命令意图顺序结算 effect；较新命令被拒绝时，较早已接受的 effect
仍须生效。更新的 deep link 在导航阶段先建立 pending target intent，发出 Agent layout
命令时无缝转交给该命令；后续操作可取消 UI continuation，但不能丢弃已发出命令的待结算
effect。issued deep-link intent 还携带完整新目标（含 RunId 或明确清空），不能只凭同一
Agent effect 保留旧 Run；显式离开当前上下文的导航仅在命令被接受后清目标，拒绝保持
原上下文；notice、Settings one-shot section 等本地副作用还必须确认该导航未被更新意图
取代。后台创建和 Focus、split、resize 等纯结构操作没有 target effect，renderer 不得
自行重演 reducer 推断后继 Tab。

### 5.7 IPC

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
- v0.2 Agent Picker 的显式路由使用无歧义边界：`@@name` 只匹配到下一个空白字符，
  含空格或与 `all` 冲突的名称使用 `@@{完整 Agent Name}`；裸 `@@all` 始终广播当前
  Project 的明确实例列表并需要二次确认。
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
    dispatch-planner.ts        revision 绑定的容量与 Project 队位规划
    mock-scenario-adapter.ts   MockScenarioAdapter（in-memory port 实现）
    run-readiness.ts           派生 effective 配置与下一 Run readiness（#14）
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
palette”和”Settings A 完整编辑器 + B 比较视图 + C readiness 摘要”。Phase 1 #1–#2 已完成
（[PR #18](https://github.com/pcliangx/agent-squad-hq/pull/18)：Project Shell + WorkbenchPort；
[PR #19](https://github.com/pcliangx/agent-squad-hq/pull/19)：全局 Connections/Provider Health/
确认宿主）；剩余 #3–#16 按 GitHub Relationships 的原生
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
npm run check:release
```

另外执行 `git diff --check`。`check:release` 包含确定性 mock Electron 冒烟，但不能替代
真实 CLI E2E 或 Electron GUI 人工验收；未运行的验证必须在交付说明中明确标注。
