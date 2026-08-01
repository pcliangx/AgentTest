# AgentTest v0.2 产品与工程计划

> 状态：Project-first 重新规划；UI/UX Design Gate 进行中
>
> 更新日期：2026-07-31
>
> 关联：[UX-v0.2](./UX-v0.2.md) ·
> [ADR-0008](./adr/0008-project-first-agent-instances.md) ·
> [领域词汇表](../CONTEXT.md)
>
> 本文件取代 [`PLAN-v0.1.md`](./PLAN-v0.1.md) 作为当前路线图，但不改写历史。

## 1. 为什么重新规划

v0.1 已证明 Electron 能同时接入 Claude Code、Codex 和 Kimi Code，并通过结构化
协议、PTY、worktree 与 `@@` 路由提供基本工作能力。但当前实现把 Provider 直接
当作 Agent：

- UI 固定为 Claude/Codex/Kimi 三个 pane；
- `AgentId` 同时承担 Provider、运行实例、会话和 worktree 标识；
- 每种 Provider 只能有一个上下文；
- 没有 Project，也没有可恢复的 Tab/Panel 工作区。

这限制了真实使用。一个“销售数据分析”Project 可能需要两个 Claude Code 实例分别
负责数据清洗和 SQL、两个 Codex 实例分别负责异常检测和预测、一个 Kimi 实例负责
可视化。产品必须管理这些**用户命名的实例**，而不是管理三个厂商槽位。

此前 v0.2 草案把 Task 提升为顶层对象，这同样不符合用户心智模型。Task、Candidate
与 Handoff 可以存在，但必须位于 Project 和 Agent Workspace 内部。

## 2. 产品定位

> AgentTest 是一个本地、Project-first、多 Agent 编码工作台。用户在 Project 中
> 创建任意数量的命名 Agent Instance，用 Tab 切换、用 Panel 并排工作，并始终掌握
> 每个实例的会话、运行、文件改动和协作边界。

它不是：

- 三个固定厂商聊天窗口；
- 无人控制的递归 swarm；
- 单纯把多个终端拼在一页；
- 以 Task 看板取代开发工作区的项目管理工具；
- 云端 Agent 托管平台。

## 3. 核心用户

- 同时使用两个以上编码 Agent 的个人开发者；
- 希望按角色拆分多个同类 Agent 的数据、研究或工程用户；
- 需要长时间保留上下文、并排观察运行、检查独立改动的高级用户；
- 希望由自己决定派发、Handoff 和落地，不接受隐式自治的用户。

## 4. 产品原则

1. **Project-first**
   - App 首先打开或创建 Project。
   - Agent、会话、布局、工作目录和协作历史都属于 Project。

2. **Instance 不是 Provider**
   - Claude Code、Codex、Kimi Code 是 Provider。
   - `cc_data`、`cx_anti`、`kimi_Visual` 是 Agent Instance。
   - 同一 Provider 可创建多个实例。

3. **任意数量，有限可见**
   - Project 可有 N 个实例。
   - 屏幕只并排有限 Panel，其余实例通过 Tabs 与 Agent Directory 管理。

4. **视图与生命周期分离**
   - 关闭 Tab 不停止 Agent。
   - 停止 Agent 不删除实例或会话。
   - 删除实例是独立危险动作。

5. **用户显式控制协作**
   - 消息和 Handoff 的目标必须是具体 Agent Instance。
   - 普通 assistant 文本中的 `@@` 不自动创建运行。

6. **结构化 Chat 为主，PTY 为工具**
   - 默认 Chat 使用厂商结构化协议。
   - Terminal 是 Agent Tab 内的显式接管模式。

7. **每实例隔离**
   - 会话、active run、PTY 和写入型 cwd/worktree 按 Agent Instance 隔离。
   - Provider adapter 只描述厂商差异。

8. **状态可恢复**
   - 重启后恢复 Project、Agent Directory、会话和 Workspace Layout。
   - 中断的运行必须明确标记，不能伪装成完成。

## 5. 当前基线与主要缺口

| 领域 | 当前已有 | v0.2 缺口 |
| --- | --- | --- |
| Provider | 三家声明式 adapter 与 registry | 明确 ProviderId，不再充当实例 ID |
| Chat | Claude stream-json、Codex JSONL、Kimi ACP | 按 AgentInstanceId 管理独立会话和 active run |
| Terminal | 每 Provider 一个 PTY | 每 Agent Instance 一个显式 PTY |
| Project | 单一 RepoPicker/base repo | Project 列表、创建/打开、元数据与恢复 |
| Agent | 三个固定实例 | N 个命名实例、同 Provider 多开、增删改查 |
| UI | 三个固定 pane | Agent Directory、Tabs、Panels、布局恢复 |
| Worktree | 每 Provider 一个 worktree | `(Project, Agent Instance)` 隔离 |
| 路由 | `@@claude` / `@@codex` / `@@kimi` | `@@<agent-name>` 与 Project 范围 `@@all` |
| 协作 | 用户可多目标派发 | 明确来源/目标实例的 Handoff |
| 持久化 | Provider 级 session store | Project、实例、布局和实例级 session store |

当前结构化协议迁移仍是有效基线，不回退到 PTY 主通道。

## 6. 领域模型

```text
Project
├─ projectId
├─ name
├─ rootPath
├─ baseBranch / baseCommit
├─ agentInstances[]
└─ workspaceLayout

AgentInstance
├─ agentInstanceId
├─ projectId
├─ name                    # project 内唯一，如 cc_data
├─ providerId              # claude / codex / kimi
├─ configuration
├─ session
├─ runtimeState
└─ workspaceRef

WorkspaceLayout
├─ panels[]
├─ focusedPanelId
└─ maximizedPanelId?

Panel
├─ panelId
├─ tabs[]                  # AgentInstanceId
└─ activeTab
```

### ID 与名称

- `ProjectId`：稳定、不透明的系统标识；
- `AgentProviderId`：adapter registry key，例如 `claude`；
- `AgentInstanceId`：稳定、不透明的实例标识；
- `AgentName`：Project 内唯一、用户可重命名的路由与显示名称；
- UI、IPC 和持久化不能用数组下标或 ProviderId 代替 AgentInstanceId。

### 不变量

1. Agent Instance 只属于一个 Project。
2. 一个 Project 内 Agent Name 唯一。
3. Provider registry 不知道 Project 或实例布局。
4. 同一 Agent Instance 同时最多一个 structured run。
5. 同一实例的 structured run 与 Terminal PTY 互斥。
6. 一个 Agent Instance 基线设计中最多打开一个 Agent Tab。
7. 一个 Tab 同时只属于一个 Panel。
8. 关闭 Tab、停止运行和删除实例是三个不同状态转换。
9. Project 切换不销毁实例；是否停止后台运行需要明确产品策略。
10. 普通 assistant 内容不能直接触发另一个实例。

## 7. 核心用户流程

### 7.1 打开或创建 Project

```text
打开 App
→ 最近 Projects
→ 选择“销售数据分析”
→ 校验目录、Git 与 Provider health
→ 恢复 Agent Directory 和 Workspace Layout
```

### 7.2 创建命名 Agent

```text
Project → New Agent
→ Provider: Claude Code
→ Name: cc_data
→ 选择配置与打开位置
→ 创建 Agent Instance
→ 在当前 Panel 打开 Tab
```

创建第二个 Claude Code 实例 `cc_sql` 不覆盖 `cc_data`。

### 7.3 Tab 与 Panel 管理

```text
点击 Agent Directory 项
→ 聚焦已有 Tab，或在 focused Panel 打开
→ 拖动 Tab 到边缘
→ 新建右侧/下方 Panel
→ Project 保存布局
```

### 7.4 定向消息

Agent Tab 内输入默认只发给当前实例。Project Composer 若启用多目标派发，目标使用
实例名称：

```text
@@cc_data @@cx_anti 检查 Q2 华东区异常数据
```

`@@all` 仅指当前 Project 的全部可用 Agent Instance。Provider 名称不能在多实例
场景中充当唯一目标。

### 7.5 显式 Handoff

```text
cc_data → “交给另一个 Agent”
→ 选择 cx_anti
→ 预览上下文、文件状态与指令
→ 用户确认
→ cx_anti 收到待处理 Handoff
```

Handoff 从 Agent Instance 指向 Agent Instance，并记录 Project、来源会话和用户
指令。它不是从普通回复里解析出的自动循环。

### 7.6 检查与落地改动

```text
Agent Tab → Changes
→ 查看实例 worktree diff 与验证
→ 检查 base drift
→ 二次确认
→ fast-forward 或进入冲突恢复
```

## 8. 模块边界

### 8.1 ProjectStore

负责：

- Project 创建、打开、更新、归档；
- Project root 与 base 信息；
- Agent Instance 元数据；
- Workspace Layout 持久化；
- schema version 与原子写入。

不负责：

- 启动 Agent 进程；
- 解析厂商协议；
- 执行 Git 命令。

### 8.2 AgentProviderRegistry

负责：

- 注册 Claude/Codex/Kimi Provider adapter；
- executable、argv、协议 decoder、capability 与 session strategy；
- 根据 `AgentProviderId` 返回 adapter。

不负责：

- Agent Name；
- 实例会话；
- Panel 布局；
- 按实例维护 active run。

### 8.3 AgentInstanceManager

负责：

- Project 内创建、重命名、停止和删除 Agent Instance；
- 校验 Agent Name 唯一性；
- 把 AgentInstanceId 解析为 Project、Provider 与 workspace；
- 协调 session/runtime/worktree 生命周期。

### 8.4 AgentRuntime

保留当前 seam，但键从 ProviderId 改为 AgentInstanceId：

- 每实例一个 active structured run；
- 每实例 native session / bounded transcript；
- 每实例 cancel、finish 与 process exit；
- 通过实例的 ProviderId 获取 adapter；
- 事件携带 projectId 与 agentInstanceId。

### 8.5 WorkspaceLayout

renderer 侧使用纯状态转换管理：

- open/focus/close/move Agent Tab；
- split/close/focus/maximize Panel；
- restore/save Project layout；
- 防止同一 Agent Tab 重复打开；
- 不把 UI 行为误映射为进程停止或实例删除。

布局模块不直接调用 Agent CLI 或 Git。

### 8.6 InstanceWorkspace

在 `(projectId, agentInstanceId)` 边界管理：

- cwd/worktree；
- status/diff/validation；
- apply 前 base drift；
- 归档与清理策略。

Provider 差异不能进入该模块。

### 8.7 HandoffService

后续负责：

- 校验来源/目标实例；
- 创建有 provenance 的 Handoff packet；
- 限制链路深度、并发与预算；
- 由用户动作触发目标运行。

首个 Project/Tab/Panel 切片不依赖 HandoffService。

## 9. v0.2 范围

### In

- Project 列表、创建/打开与最近项目；
- Project 内 N 个命名 Agent Instance；
- 同一 Provider 多实例；
- Agent Directory；
- Agent Tab 打开、聚焦、关闭和移动；
- Panel 横/纵拆分、关闭、最大化与布局恢复；
- 每实例结构化 Chat、Session、PTY 与运行状态；
- 每实例 worktree/status/apply；
- 按 Agent Name 定向路由；
- Provider Doctor 与可操作错误；
- App 重启后的 Project、实例和布局恢复。

### Later

- Project 内 Task/Candidate 模型；
- Candidate 并排比较；
- 用户触发的 Review/Revision Handoff；
- 保存多套命名 Layout；
- 同一实例的镜像视图；
- 后台 Project 的长期运行策略。

### Out

- 从普通 agent 回复自动解析 `@@` 并派发；
- 无人确认的递归自治；
- 动态第三方 Provider marketplace；
- 云同步和多人协作；
- 自动解决 Git conflict；
- 把本机命令执行描述成完整安全沙箱。

## 10. 实施阶段

### Design Gate：Project Workspace UI/UX

生产功能开发暂停，先完成 [UX-v0.2](./UX-v0.2.md)：

- Project、Agent Instance、Tab 与 Panel 信息层级；
- New Agent、Tab 移动、Panel 拆分与 Project 恢复流程；
- A/B/C 三个结构方向与 D 推荐组合稿；
- 用户选型与设计决策记录。

验收：

- 用户确认 Project-first；
- 用户选择主布局或组合方案；
- 关闭 Tab、停止和删除没有歧义；
- 1280×800 下可管理至少 8 个实例并同时观察 3 个。

### Phase 0：稳定结构化 Provider 基线

- Provider Doctor：executable、version、auth、capability；
- 三家 fresh/resume/cancel 真实 E2E；
- 结构化错误分类和 run watchdog；
- Electron GUI smoke test；
- 保持 PTY 仅为 Terminal。

### Phase 1：Project 与 Agent Instance 核心

- ProjectStore 最小 schema；
- 拆分 `AgentProviderId` 与 `AgentInstanceId`；
- Agent Instance create/list/rename/stop/delete；
- 同 Provider 多实例；
- runtime、session、PTY IPC 改用 AgentInstanceId；
- 从固定三实例数据迁移或提供明确重建提示。

验收：

- “销售数据分析”Project 可创建 `cc_data`、`cc_sql`、`cx_anti`、
  `cx_forecast`、`kimi_Visual`；
- 两个 Claude Code 实例会话互不覆盖；
- 重启 App 后 Project 与五个实例仍存在；
- 删除一个实例不影响同 Provider 的另一个实例。

### Phase 2：Tabs、Panels 与布局恢复

- Agent Directory；
- Agent Tab reducer；
- split tree 或等价 Panel layout model；
- drag/move/focus/close/maximize；
- 每 Project 保存和恢复布局；
- 关闭、停止、删除的独立交互。

验收：

- 8 个 Agent 可通过 Tabs 管理；
- 3 个 Agent 可同时显示；
- 同一实例不会意外打开重复 Tab；
- 关闭 Tab 后会话和运行状态保持；
- 切换 Project 后各自布局正确恢复。

### Phase 3：每实例 workspace 与路由

- worktree key 改为 `(projectId, agentInstanceId)`；
- status/diff/apply 按实例；
- `@@<agent-name>` 解析和名称冲突校验；
- `@@all` 限于当前 Project；
- Project Composer 与 Agent Composer 的目标语义分离。

验收：

- 同 Provider 两个实例可以从相同 base 独立改动；
- 路由 `@@cc_data` 不会误发给 `cc_sql`；
- rename 后旧名称不再路由，新名称立即生效；
- 应用改动仍要求主仓库干净和二次确认。

### Phase 4：受控 Handoff

- 来源/目标 Agent Instance；
- Handoff packet 与 provenance；
- review/revision 状态；
- 深度、并发和预算限制；
- 用户确认后才启动目标。

### Phase 5：产品收尾

- Project Home 与最近项目；
- Provider/Agent 状态可访问性；
- 空态、失败、恢复和离线目录；
- 键盘导航与焦点管理；
- 真实多实例 GUI checklist；
- 文档、迁移说明和 release checklist。

## 11. 发布门槛

1. Project 是唯一顶层工作空间。
2. 同一 Project 至少可稳定创建 8 个 Agent Instance。
3. 同一 Provider 至少两个实例可并行且会话隔离。
4. Tab/Panel 操作不改变 Agent 生命周期，除非用户显式执行。
5. Project 切换和 App 重启可恢复实例与布局。
6. 每实例 Chat/Terminal 互斥和 process-exit 边界仍正确。
7. worktree、diff、apply 按实例隔离。
8. 路由目标为 Agent Name，不把 Provider 当唯一实例。
9. 普通 assistant 文本不会隐式触发另一个 Agent。
10. `npm run typecheck && npm test && npm run build` 通过。
11. 三家真实 CLI E2E 与 Electron 多实例 smoke test 有可重复记录。

## 12. 迁移

- 当前 `AgentId` 先重命名为 `AgentProviderId`，避免在新代码中继续扩散错误语义；
- 为现有三家状态创建一次性默认 Project 和实例名，或在开发期明确清空旧状态；
- 旧 Provider 级 session/worktree 不得静默绑定到错误实例；
- renderer 的三 pane 状态只作为迁移输入，不作为新布局 truth；
- 结构化 adapter、decoder、ACP driver 和 PTY 能力保留。

## 13. 主要风险

| 风险 | 对策 |
| --- | --- |
| ProviderId 与 InstanceId 混用 | 类型拆分，IPC/event 强制携带 instanceId |
| N 个实例导致进程/额度失控 | Project/全局并发上限，状态可见，显式启动 |
| Tabs/Panels 状态复杂 | 纯 reducer + 不变量测试，布局与 runtime 解耦 |
| 关闭 Tab 意外停止工作 | 关闭/停止/删除三个独立命令和文案 |
| 同名导致错误路由 | Project 内创建/重命名时强制唯一 |
| 同 Provider session 串线 | SessionStore 以 instanceId 分区 |
| 多 worktree 磁盘膨胀 | 可见用量、归档和确认式清理 |
| Project 切换时后台运行含糊 | Design Gate 明确策略，未决定前不默认销毁 |
| Panel 过多造成不可用 | 默认最多三可见 Panel，更多实例用 Tabs |

## 14. 决策记录

已接受：

- [ADR-0007](./adr/0007-structured-chat-pty-terminal.md)：结构化 Chat 为默认通道，
  PTY 只负责 Terminal。
- [ADR-0008](./adr/0008-project-first-agent-instances.md)：Project-first、N 个命名
  Agent Instance、Provider/Instance 分离、Tab/Panel 工作区。

后续在实施前需要确认：

- Project 切换时 active Agent 是否允许后台继续运行；
- 一个 Project 的多个实例默认使用独立 worktree 还是允许显式共享只读目录；
- Panel layout 采用 split tree 还是二维 grid；
- Agent Name 重命名对历史 Handoff 显示和 `@@` alias 的影响。

## 15. 下一步

当前不进入生产实现。先评审 [UX-v0.2](./UX-v0.2.md) 的 A/B/C/D 原型，重点确认
D 推荐组合稿：

1. Project 与 Agent Directory 放在哪里；
2. Tabs 是 Panel 内局部管理还是全局管理；
3. Panel 如何拆分、移动和最大化；
4. New Agent 的默认打开位置；
5. Project 切换时是否保留后台运行。

选型记录完成后，从 Phase 0 和 Phase 1 开始，不再实现 Task-first TaskStore。
