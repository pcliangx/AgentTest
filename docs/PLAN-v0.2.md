# Agent Squad HQ v0.2 产品与工程计划

> 状态：设计基线已冻结，Design Gate 已关闭；Phase 1 #1 已完成，#2–#16 待推进
>
> 更新日期：2026-08-02
>
> 关联：[UX-v0.2](./UX-v0.2.md) ·
> [ADR-0008](./adr/0008-project-first-agent-instances.md) ·
> [ADR-0009](./adr/0009-command-center-workspace-lifecycle.md) ·
> [ADR-0010](./adr/0010-feishu-integration-trust-boundaries.md) ·
> [ADR-0011](./adr/0011-ui-first-contract-driven-delivery.md) ·
> [ADR-0012](./adr/0012-enforced-execution-and-brokered-capabilities.md) ·
> [ADR-0013](./adr/0013-agent-squad-hq-product-identity.md) ·
> [领域词汇表](../CONTEXT.md)
>
> 本文件取代 [`PLAN-v0.1.md`](./PLAN-v0.1.md) 和 2026-07-31 版 v0.2 路线，历史
> 文档只作背景。

## 1. 为什么再次规划

v0.1 已证明 Electron 可以同时接入 Claude Code、Codex 和 Kimi Code，并通过
structured stdio、PTY、worktree 与显式 `@@` 路由完成基本工作。但当前生产实现仍把
Provider 当作 Agent：

- UI 固定为 Claude/Codex/Kimi 三个 pane；
- `AgentId` 同时承担 Provider、实例、session、runtime、PTY 和 worktree 标识；
- 没有 Project、N 个同类实例、可恢复 Tab/Panel 工作区；
- 飞书任务、知识、外部写入和 Attention 尚未进入正式领域模型；
- 窗口关闭、Project 切换、退出 handoff、归档和失败审计没有统一生命周期。

产品方向经过设计访谈后进一步明确：Agent Squad HQ 不是单纯的多 Agent 编码器，而是
**集成工作台与指挥中心**。Tasks、Knowledge、Handoffs、Activity、权限和外部连接是
Project 一级能力；外部事件仍不能在本阶段自动启动 Agent。

本次规划同时调整交付顺序：设计冻结后，先实现生产级 UI、自由布局和契约化 mock，
再接入 Project-first 内核。这样先验证指挥中心体验，又避免 renderer 伪造业务规则。

## 2. 产品定位

> Agent Squad HQ 是一个本地优先、Project-first 的多 Agent 集成工作台。用户在 Project
> 中创建任意数量的命名 Agent Instance，以自由 Panel/Tab 工作区组织屏幕，通过
> Overview、Tasks、Knowledge、Handoffs、Activity 和 Attention Center 显式指挥、
> 观察、授权、验收和交接工作。

它不是：

- 三个固定厂商聊天窗口；
- 无人控制的递归 swarm；
- 单纯把多个终端拼在一页；
- 以 Task 看板取代 Project/Agent 工作区；
- 复用浏览器 Cookie 执行外部 CRUD 的自动化壳；
- 云端 Agent 托管、多用户协作或自动触发平台；
- 用 worktree 或提示词冒充完整安全 sandbox 的系统。

## 3. 核心用户与场景

- 同时使用两个以上编码 Agent 的个人开发者；
- 按数据清洗、SQL、异常检测、预测、可视化等角色拆分多个同类 Agent 的用户；
- 需要把飞书任务和知识纳入同一指挥台，但保留人工权限和最终验收的团队成员；
- 需要长时间后台运行、跨 Project 观察、可靠恢复和退出交接的高级用户；
- 要求每个 Run、权限、外部写入、文件改动和合并都可追踪的用户。

示例 Project“销售数据分析”：

| Agent Name | Provider | 当前工作 |
| --- | --- | --- |
| `cc_data` | Claude Code | 清洗 Q2 销售流水 |
| `cc_sql` | Claude Code | 维护 SQL schema 与查询 |
| `cx_anti` | Codex | 检查异常值处理策略 |
| `cx_forecast` | Codex | 生成季度预测模型 |
| `kimi_Visual` | Kimi Code | 绘制区域销售趋势 |

## 4. 产品原则

1. **Project-first**
   - Agent、布局、任务引用、知识范围、handoff、运行与审计都属于 Project。
   - Project 可以暂时非 Git，但可运行写入 Agent 必须绑定 Git。

2. **Instance 不是 Provider**
   - Provider registry 以 `AgentProviderId` 查 adapter。
   - runtime、session、PTY、worktree、IPC 和 UI 以 `AgentInstanceId` 管实例。
   - Provider 创建后不可切换；换 Provider 等于新建实例并 handoff。

3. **任意数量，有限可见**
   - Project 可有 N 个 Agent；同一 Provider 可多开。
   - Panel 支持 N 个，1–3 个是默认密度；更多 Agent 通过 Panel 内 Tabs 管理。

4. **视图与生命周期分离**
   - 关闭 Tab、停止 Run、结束 PTY、归档实例和永久删除是不同命令。
   - 切换 Project 不停止后台 Run；关闭窗口不等于退出应用。

5. **用户显式启动**
   - 创建、恢复、导入、外部事件和 assistant 文本都不会启动 Run。
   - 消息、Dispatch 和 Handoff 的目标必须是可见的具体 Agent Instance。

6. **结构化 Chat 为主，PTY 为接管工具**
   - structured Run 与 Terminal PTY 按实例互斥。
   - `turn-complete` 与 `process-exited` 保持不同边界。

7. **每实例隔离**
   - 可写 Agent 使用独立 worktree，不共享可写 cwd。
   - session、Run、PTY、配置快照和环境按实例分区。

8. **权限必须真实**
   - 只展示 adapter、protocol、sandbox、host 或 connector 能真正强制的限制。
   - 期望策略不可执行时默认阻止 Run，不能静默放宽。
   - 原生 auto-approve/bypass 不等于有效权限；最小 PermissionBroker 必须早于真实 Run。
   - Agent 只获得受控外部能力，不获得 Agent Squad HQ 管理的原始连接身份。

9. **外部系统有明确 truth**
   - 飞书持有任务业务字段和知识内容；Agent Squad HQ 持有 Dispatch、Run、Result、
     worktree、validation、handoff 和 audit。
   - 冲突不能静默覆盖，最终任务完成由用户验收。

10. **本地优先与可恢复**
    - 默认不云同步、不上传遥测；秘密进入系统钥匙串。
    - 数据库事务化、版本化迁移并保留滚动恢复快照。
    - crash、失败、取消和中断必须如实记录。

## 5. 当前生产基线与缺口

| 领域 | 当前已有 | v0.2 目标缺口 |
| --- | --- | --- |
| Provider | 三家声明式 adapter/decoder/driver | Provider Doctor 全能力门禁；ProviderId 类型化 |
| Chat | Claude stream-json、Codex JSONL、Kimi ACP | 按 AgentInstanceId 的 N 实例、队列与 RunStore |
| Session | Provider 级 native resume/transcript | 实例级成功 Session 与失败 Run 审计分离 |
| Terminal | 每 Provider 一个 PTY | 每实例持久 PTY，关闭 Tab 不结束接管 |
| Project | 单一 RepoPicker/base repo | ProjectStore、最近项目、归档、重新定位与迁移 |
| Agent | 三个固定槽 | N 个命名实例、Provider immutable、归档/恢复 |
| UI | 三个固定 pane | 单窗口指挥中心、一级 surfaces、Attention、Settings |
| Layout | 固定 pane | 自由 split tree、拖动、N Panel、Tab 唯一与恢复 |
| Worktree | 每 Provider 一个 worktree | `(ProjectId, AgentInstanceId)` 隔离与漂移恢复 |
| Routing | `@@claude/codex/kimi/all` | Agent Picker/chips 与 `@@<agent-name>` |
| Handoff | 无规范记录 | canonical HandoffStore、退出 handoff、跨项目导入 |
| Feishu | 无正式集成 | 全局连接、Project scope、隔离浏览器、CLI CRUD |
| Permissions | Kimi 协议权限与零散确认 | 统一 Permission Center、有效策略与审计 |
| Tasks/Knowledge | 无正式 Project surface | 外部 truth 投影、Dispatch、结果、缓存与冲突 |
| Persistence | Provider session store | Project/Run/Layout/Handoff/Binding/Attention stores |

当前 structured stdio、PTY、worktree 和 ff-only 合并仍是有效基线，不回退。

## 6. 领域模型

```text
Project
├─ projectId
├─ name / rootPath / repositoryIdentity
├─ lifecycleState: active | archived
├─ rootAvailability: available | unavailable
├─ repositoryReadiness: ready | not-ready
├─ activitySummary / attentionCount (derived)
├─ primaryConnectionId?
├─ resourceBindings[]
├─ agentInstances[]
├─ workspaceLayout
└─ appliedConfigurationVersion

AgentInstance
├─ agentInstanceId / projectId
├─ name / providerId
├─ configurationDraft / appliedConfiguration
├─ sessionRef / runtimeState / ptyState
├─ workspaceRef
└─ archiveState

WorkspaceLayout
├─ root: SplitNode | PanelNode | null
├─ focusedPanelId?
├─ temporaryFocusPanelId?
└─ currentSurface

SplitNode
├─ splitNodeId
├─ direction: horizontal | vertical
├─ ratio
├─ first: LayoutNode
└─ second: LayoutNode

Panel
├─ panelId
├─ tabs[]: AgentInstanceId
└─ activeTabId?

Run
├─ runId / projectId / agentInstanceId
├─ dispatchId? / input / configurationSnapshot
├─ events / permissionDecisions / externalOperations
├─ usage / processExit / resultBoundary
└─ status: queued | running | succeeded | failed | cancelled | interrupted

Dispatch
├─ dispatchId / projectId / targetAgentInstanceId
├─ taskRef? / instruction / queuePriority
└─ runIds[] / executionResult?

Handoff
├─ handoffId / projectId / sourceAgentInstanceId
├─ targetAgentInstanceId? / provenance
├─ goal / summary / externalRefs / baseCommit
├─ changeSummary / selectedArtifacts / validation
└─ completeness

ExternalConnection
├─ connectionId / provider / identityMetadata
└─ secretRef

ResourceBinding
├─ projectId / connectionId / externalResourceId
├─ resourceType / allowedOperations
└─ externalVersion / syncState
```

### 6.1 ID 与名称

- 所有系统 ID 稳定、不透明，不能由名称或路径推导；
- Agent Name 在 Project 内大小写不敏感唯一；
- rename 不改变 `AgentInstanceId`，旧名称不自动成为 alias；
- history/Handoff 保存当时名称快照和稳定 ID；
- connection、task、knowledge 与 handoff 引用不能用可见标题作为主键。

### 6.2 不变量

1. Agent Instance 只属于一个 Project，Provider 创建后不可变。
2. 一个 Agent Instance 同时最多一个 structured Run；PTY 与 structured Run 互斥。
3. 仅成功回合进入 SessionStore；所有终态 Run 进入 RunStore。
4. 一个 Agent Instance 在单一主窗口最多一个打开 Tab。
5. 一个 Tab 同时只属于一个 Panel；Layout 是 split tree，不是 runtime 状态。
6. 关闭 Tab、切换 Project和关闭窗口都不改变 Run/PTY，除非用户显式操作。
7. 外部事件、assistant 文本和导入不能自动启动 Agent。
8. 可写 Agent 必须拥有独立 worktree；共享可写 cwd 永不允许。
9. `Project scope ∩ Run instruction ∩ connector capability` 决定外部有效权限。
10. 无法强制期望权限时阻止 Run，不做隐式宽化。
11. 飞书删除/批量/成员/权限以及本地永久/丢弃/合并始终二次确认。
12. Settings 应用后名称/路由元数据立即生效，运行配置只影响下一次 Run；每个 Run
    有脱敏配置快照。
13. Project lifecycle、root availability、Git readiness、activity 与 attention 是正交维度；
    Provider/连接故障只降级相关能力。
14. Project 可以没有飞书主连接；有连接时 v0.2 最多一个。
15. 飞书写入只能经受控 Connector 代执行，Agent 不持有已认证原始 CLI 上下文。

## 7. 核心用户流程

### 7.1 创建或打开 Project

```text
打开 App
→ 恢复最后 Project；不可用时显示最近项目
→ 新建 Project：名称 + 本地目录（Git 可暂缺）
→ 进入 Project Overview
→ 可选连接飞书主连接与资源范围
→ 创建可运行 Agent 前校验或初始化 Git
```

Project root 丢失时 `rootAvailability = unavailable`，历史可读。重新定位必须
无活动 Run，并验证为同一 Git repository identity；不同仓库必须创建新
Project。未初始化 Git 的 Project 仍可用，但 `repositoryReadiness = not-ready`，
不能创建可运行 Agent。

### 7.2 创建 Agent

```text
Project → New Agent
→ Provider Doctor 必须完全通过
→ 输入唯一 Agent Name
→ 选择 Provider、模型、打开位置和初始 worktree 配置
→ 预览复制字段（排除 secrets/proxy/env）
→ 创建 Ready 实例与独立 worktree
→ 打开 Tab 或保留后台
→ 用户发送消息/显式派发后才创建 Run
```

### 7.3 Workspace 操作

```text
点击 Agent Directory
→ 聚焦唯一现有 Tab，或在 focused Panel 打开
→ 拖 Tab 到另一 Panel 中部：移动
→ 拖到边缘：创建横/纵 split 并移动
→ 拖 divider：自由调比例并自动保存
→ Focus：临时只显示一个 Panel，退出后恢复 tree
```

### 7.4 显式派发与任务验收

```text
Overview / Task / Command Palette → 派发给 Agent
→ Agent Picker 选择明确目标 chips
→ @@all 展开为当前 Project 可用实例列表
→ 预览 instruction、资源范围、并发队列与成本
→ 每个目标创建独立 Dispatch
→ Run 在自己的 worktree 中执行
→ 展示 Execution Result 与 validation
→ 用户决定是否写回飞书业务状态
```

### 7.5 Handoff

```text
来源 Agent → 生成 Handoff
→ 预览 goal、summary、refs、base、diff/patch/artifacts、validation
→ 同 Project：选择目标实例并显式导入
→ 跨 Project：导出 packet → 披露内容 → 显式导入为新 Handoff
→ 目标只在自己的 worktree 中应用材料
```

### 7.6 改动落地

```text
Changes → diff + validation + base drift
├─ 无 drift：主仓库干净 → 二次确认 → ff-only
└─ 有 drift：Needs rebase，base 不动
   → 实例 worktree 显式更新/解冲突/重验
   → 二次确认 → ff-only
```

### 7.7 关闭、退出、归档

- 关闭 Tab：只关闭视图；
- 关闭窗口：后台继续，系统通知；
- 切换 Project：后台继续，保存/恢复各自布局；
- 退出 Agent Squad HQ：处理 active Run，为 dirty Agent 生成 handoff，失败则生成不完整快照；
- 归档 Agent/Project：先处理 Run 和 handoff，之后禁止新执行与外部写入；
- 永久删除：影响预览、不可绕过确认和脏 worktree 处置。

## 8. 数据主权、权限与安全边界

### 8.1 飞书连接

- App 全局支持多个连接，凭据在系统钥匙串；
- v0.2 每个 Project 可选 `0..1` 个主 `connectionId`；
- Project 保存任务清单、知识空间、文档和动作范围；
- 改主连接前展示 broken bindings、unsynced changes 和权限差异；
- 浏览器按 ConnectionId 使用独立持久 partition，Connector 使用官方独立授权；
  禁止 Cookie 复用/抓取/注入；
- 浏览器仅信任飞书域名，外链到系统浏览器，Node integration 禁用。
- 未连接飞书只关闭在线 Tasks/Knowledge/CRUD，不改变 Project 生命周期或 root 可用性。

### 8.2 CRUD 与冲突

- 当前 Run 用户指令可授权明确读取、创建和单条更新；
- 删除、批量、成员和权限变化永远预览 + 二次确认；
- connector 执行前再次校验 scope、identity、version 和 action；
- 外部写入失败保留 proposed change，不伪装成功；
- 离线知识缓存只读、带版本；
- 外部版本冲突进入 Attention，不静默 last-write-wins。

### 8.3 权限中心

协议归一化 `permission-requested`，统一进入 Needs Input/Permission Center，允许：

- deny；
- allow once；
- allow current Run。

永久授权只能在 Settings 修改，超时默认 deny。App 高风险确认与 Agent permission
request 是两层独立防线。

### 8.4 本地数据

- ProjectStore、RunStore、SessionStore、handoff 和 audit 默认仅本机；
- 凭据、Token 和秘密不进入 ProjectStore、env、transcript、handoff 或导出；
- 写入事务化、schema versioned，并保留滚动快照；
- 导出先展示清单，默认排除凭据、Cookie、Token 和完整飞书缓存；
- 导入/恢复不启动 Run、不执行飞书写入。

## 9. 模块边界

### 9.1 UI Contract 与 MockScenarioAdapter

负责：

- 版本化 `ViewModel`、`Command`、`Event`、error/empty/loading states；
- 在生产 UI 阶段驱动完整交互场景；
- 与真实 adapter 共用 contract tests。

不负责：持久化 truth、Agent 进程、Git、凭据、权限执行或外部 CRUD。

### 9.2 ProjectStore

负责 Project、实例元数据、资源引用、配置 draft/applied version、Workspace Layout、
schema migration、事务写入、归档和恢复引用。它不启动 Agent、不解析协议、不执行 Git。

### 9.3 AgentProviderRegistry 与 ProviderDoctor

registry 只按 `AgentProviderId` 返回声明式 adapter/decoder/driver。Doctor 检查
executable、version、auth、capability 和可执行权限。禁止 Provider 特判扩散到
router、runtime、workspace 或 UI。

### 9.4 AgentInstanceManager

负责 create/list/rename/archive/restore/permanent-delete、名称唯一、Provider immutable、
Project/Git/Doctor 前置条件以及 session/runtime/worktree 生命周期协调。

### 9.5 AgentRuntime、RunStore 与 SessionStore

- runtime 以 `AgentInstanceId` 管单 active structured Run、cancel、finishing 和 exit；
- RunStore 记录所有 Run 输入、事件、权限、工具、外部 CRUD、usage 和终态；
- SessionStore 只记录成功回合与 native resume/bounded transcript；
- 事件必须携带 projectId、agentInstanceId、runId。

### 9.6 WorkspaceLayout

renderer 纯状态模块：open/focus/close/move Tab，split/resize/prune/focus Panel，保存/恢复
Project layout，保证实例 Tab 唯一。它不调用 runtime、PTY、Git 或 connector。

### 9.7 InstanceWorkspace

以 `(projectId, agentInstanceId)` 管独立 worktree、status/diff/validation、base drift、
显式更新、archive cleanup 和 ff-only apply。Provider 差异不能进入该模块。

### 9.8 PermissionBroker 与 AttentionCenter

PermissionBroker 计算有效权限、阻止不可执行策略、规范化审批和保存决定。Attention
Center 聚合跨 Project 待处理引用并提供 deep link；已处理项保留审计。最小
PermissionBroker 是 AgentRuntime 的前置依赖，Provider 原生 auto-approve 不能取代它。

### 9.9 HandoffService

创建 canonical Handoff、dirty 判定、最终 handoff、确定性 fallback snapshot、同项目
导入、跨项目导出/导入和 provenance。Markdown 是表现格式，不是身份 truth。

### 9.10 ExternalConnectionStore、FeishuConnector 与 BrowserPolicy

- ConnectionStore 管全局连接元数据和 keychain secret refs；
- FeishuConnector 验证 Project/Run scope、版本、风险级别并代为执行官方 CLI/OpenAPI；
- BrowserPolicy 管可信域名、按 ConnectionId 的 partition、Node 禁用、导航、外链、
  下载和权限；
- 三者不能互相泄漏浏览器 Cookie、长期 Token 或 renderer 权限。
- Agent 只提交类型化 capability request，不获得 Connector profile、原始 argv 或高风险
  confirmation token 的生成权。

### 9.11 TaskProjection 与 KnowledgeIndex

保存外部 ID、版本、只读缓存、同步/冲突状态和 Agent Squad HQ 自有 Dispatch/Result 引用；
不把投影当成飞书业务 truth，不直接启动 Agent。

## 10. v0.2 范围

### In

- Project 列表、创建、最近项目、重新定位、归档、恢复与永久删除；
- Project 内 N 个命名 Agent Instance、同 Provider 多实例、Provider immutable；
- Provider Doctor 创建/配置门禁与已有 Unavailable 实例恢复；
- 单主窗口、固定 Project surfaces、Global Attention Center；
- 自由 split tree、N Panel、Tab 拖动、Focus/Analysis、布局恢复；
- 每实例 structured Chat、Run、Session、PTY、队列和配置快照；
- 每实例独立 worktree、diff、validation、drift、ff-only apply；
- Agent Picker、可见目标 chips、`@@<agent-name>` 与确认式 `@@all`；
- canonical Handoff、退出 handoff、fallback snapshot、跨项目 packet；
- 全局多飞书连接、Project 可选单主连接和资源范围；
- 按连接隔离的飞书浏览器与受控官方 CLI CRUD 能力；
- Tasks、Knowledge、Dispatch、Execution Result、用户最终验收；
- Permission Center、外部高风险确认、冲突和完整 Run 审计；
- 本地优先存储、滚动快照、预览式导出/导入；
- v0.1 默认 Project 与三槽数据迁移。

### Later

- 外部事件自动触发规则；
- 完整 Candidate 比较、Review/Revision 编排；
- 同一 Agent 的显式镜像视图；
- 多主窗口与 Tab 脱离；
- 同一 Project 多飞书租户连接；
- 用户定义 Agent Name aliases；
- 保存多套命名 Layout；
- 独立后台 daemon；
- 云同步、多人协作、团队策略中心；
- 第三方 Provider/Connector marketplace。

### Out

- 从 assistant 普通文本自动解析 `@@` 并派发；
- 无确认递归自治；
- 共享可写 cwd；
- 浏览器 Cookie 复用于 Agent；
- 静默权限放宽、冲突覆盖、rebase 或 force merge；
- 自动级联删除飞书资源；
- 用提示词声称实现文件/网络安全限制。

## 11. 实施阶段

每一阶段必须形成可运行、可观察、可验收的纵向切片，不能先堆完整静态 UI 再在最后
补真实状态，也不能先完成所有后端再一次性接线。

### Phase 0：冻结设计基线

状态：**已完成（2026-08-02）**。冻结结果见
[`UX-v0.2`](./UX-v0.2.md) 与
[`ui-first-command-center/spec.md`](../.scratch/ui-first-command-center/spec.md)。

范围：

- 评审 [`docs/design`](./design/README.md) B 版指挥中心与 Settings A/B/C；
- 记录选择或组合理由；
- 冻结导航、布局、状态、文案、确认层级与 1280×800 密度；
- 把 `ProjectId`、`AgentInstanceId`、Run、Dispatch、Handoff、Permission、
  Attention、Layout 的最小 TypeScript contract 写入 spec 与 GitHub Issues；
- 为生产 UI 建立 `.scratch/<feature>/spec.md` 与采用原生依赖的纵向 GitHub Issues。

验收：

- 用户明确选择两页的视觉主结构；
- 本 UX/PLAN/ADR 无未决产品语义；
- 原型明确 throwaway，生产实现不复制；
- Design Gate 得到用户明确放行。

### Phase 1：生产 UI 与契约化 Mock

范围：

- 正式 design tokens、shell、Project 导航和组件基础；
- Overview、Agents、Tasks、Knowledge、Handoffs、Activity、Attention、Settings；
- 真实 split tree reducer、Panel/Tab drag/drop、divider、Focus/Analysis、键盘与焦点；
- 全部关键状态：empty/loading/ready/queued/running/needs-input/permission-requested/
  failed/interrupted/conflict/offline/unavailable/archived；
- 版本化 ViewModel/Command/Event ports 和 MockScenarioAdapter；
- 组件、交互、a11y 与视觉回归测试。

此阶段禁止：真实 Agent、PTY、Git mutation、ProjectStore 迁移、飞书登录/写入和
`localStorage` canonical state。

验收：

- 1280×800 下至少管理 8 个 Agent、同时观察 3 Panel；
- 可创建第 4 个 Panel，只有非阻断提示；
- 同一 Agent 不会打开重复 Tab；Tab 能跨 Panel 移动且不改变生命周期；
- 所有危险、权限、冲突、离线和恢复状态可通过 mock 完整演示；
- UI 没有 Provider 固定槽或业务规则特判。

### Phase 2：Project-first 内核与 UI 接入

范围：

- ProjectStore 最小 schema、事务、migration 与滚动快照；
- 拆分 `AgentProviderId` / `AgentInstanceId`；
- Project create/open/rename/relocate/archive/restore；
- Agent Instance metadata、Agent Name 唯一和 Provider immutable；
- Workspace Layout 持久化与恢复；
- 用真实 store adapter 逐步替换 Project/Layout mock。

验收：

- 创建 Project 和 5 个示例实例，重启后身份与布局保持；
- root 丢失进入 Unavailable，同仓库重新定位可恢复；
- rename 不破坏历史引用，旧名称不发送；
- store migration 中断可恢复且不会自动启动 Run。

### Phase 3：Agent 执行闭环

范围：

- Provider Doctor：executable、version、auth、capability、permission enforcement；
- 最小 PermissionBroker：effective policy、deny-by-default、不可执行策略阻断；
- Provider 原生 permission request 归一化，移除新主链路中的自动允许；
- AgentInstanceManager 与每实例 runtime/session/PTY IPC；
- RunStore、每实例单 active Run、Project 3 / Global 6 队列；
- 每实例独立 worktree、status/diff/validation；
- structured Run / PTY 互斥与关闭 Tab 后 PTY 恢复；
- Agent Picker、实例名路由、可见 chips 和确认式 `@@all`；
- UI 从 runtime/store 真实 adapter 接收状态。

验收：

- Doctor 未通过时不能创建或配置新实例；已有实例只读 Unavailable；
- 最小 Broker 未就绪时不能启动真实 Run；原生权限请求不自动批准；
- 两个同 Provider 实例可并行且 session/worktree 不串线；
- excess Run 可见排队、重排、取消；Terminal 占实例槽；
- 只有用户消息/派发启动 Run；外部变化和恢复不启动；
- 仅成功回合进入 SessionStore，所有失败边界进入 RunStore。

### Phase 4：安全、生命周期与 Handoff

范围：

- 完整 Permission Center、审批历史、临时放行与高风险独立确认；
- Global Attention Center、deep link、系统通知与审计；
- HandoffStore/Service、dirty 判定、Markdown view/export；
- close-window / quit-app、最终 handoff 与 fallback snapshot；
- Agent/Project archive、restore、permanent delete；
- base drift、显式更新、冲突恢复与 ff-only apply；
- 配置 draft/apply、下一 Run 快照、secret redaction。

验收：

- 不可执行权限策略阻止 Run，不能通过一次 warning 绕过；
- permission timeout 默认 deny；永久授权只能 Settings 修改；
- 关闭窗口后台继续，显式退出完成 handoff 或产生可辨识不完整快照；
- 脏 worktree、永久删除和合并都经过不可绕过确认；
- crash/forced quit 标记 Interrupted，Electron main 不遗留子进程。

### Phase 5：飞书读取与浏览闭环

范围：

- ExternalConnectionStore、系统钥匙串与 App 全局多连接；
- Project `0..1` 主连接、未连接状态、Resource Binding 和切换影响预览；
- BrowserPolicy、按 ConnectionId 隔离的持久 partition、可信域、Node 禁用、外链；
- Tasks/Knowledge read projection、版本化缓存、offline read-only；
- 人工浏览器身份与 CLI 身份分别展示；
- 真实 store/connector adapter 替换 Feishu read mocks。

验收：

- 同一连接被多个 Project 复用时 scope 不串线；
- 不同 ConnectionId 不共享 Cookie；未连接 Project 仍可使用本地工作面；
- 用户可在内嵌飞书页面按原权限编辑；Cookie 不进入 CLI/renderer/ProjectStore；
- 外链进入系统浏览器，非信任导航被阻止；
- offline cache 明确只读和版本，不能伪装实时 truth；
- 外部变化只刷新/提醒，不自动启动 Agent。

### Phase 6：飞书 CRUD 与显式协作闭环

范围：

- 当前 Run 指令、Project scope 和 connector capability 交集；
- Agent 到 FeishuConnector 的类型化窄能力请求；
- Connector 代执行的官方 CLI/OpenAPI create/read/update/delete 与外部操作审计；
- 删除/批量/成员/权限不可绕过二次确认；
- external version conflict、proposed change 和 retry；
- 同一 Task 多 Agent Dispatch、独立 Run/Result、用户最终验收；
- 本地 Project Task 显式发布飞书；
- Handoff 引用 Task/Knowledge，跨 Project export/import。

验收：

- Agent 只能访问当前 Project/Run 授权资源，不能拿长期 secret；
- Agent 不能绕过 Connector 使用 Agent Squad HQ 管理的已认证原始 CLI/profile；
- 失败写入保留拟议内容且不更新成功状态；
- 多 Agent 完成不会自动把飞书任务标为完成；
- 高风险操作不能被 Agent permission approval 或项目配置绕过；
- 所有外部 CRUD 记录 identity、scope、target version、confirmation 和 result。

### Phase 7：迁移、恢复与发布加固

范围：

- v0.1 三 Provider 槽位迁移为默认 Project 和稳定实例；
- 本地备份/导出/导入、redaction 与恢复演练；
- schema migration、崩溃恢复、资源与磁盘用量；
- 性能、可访问性、键盘、通知隐私和安全测试；
- 三家真实 CLI E2E、Feishu test tenant E2E、Electron GUI checklist；
- release notes、迁移说明和回滚方案。

验收：见下一节发布门槛。

## 12. v0.2 迁移

首次升级采用事务性、幂等迁移：

1. 备份旧 Provider 级 session、renderer 状态和可识别 worktree 元数据；
2. 创建“默认项目”，绑定当前仓库；
3. 对已配置或存在历史的 Claude/Codex/Kimi 槽位生成稳定 AgentInstanceId 和命名实例；
4. Provider 当前不可用但有数据时保留实例并标记 `Unavailable`；完全空白且未配置的
   槽位不创建实例；
5. 尽量原样迁移 session、transcript、设置和可验证的 worktree 关系；无法证明归属的
   数据进入人工恢复清单，不能静默绑定；
6. 原三栏转换为三个 Panel/Tab，不启动任何 Run；
7. 新 store 提交成功前保留旧数据备份，失败可回滚；再次启动不会重复创建实例。

开发期不能用“清空旧状态”代替发布迁移，除非在专用测试 fixture 中明确执行。

## 13. 发布门槛

### 产品与交互

1. Project 是唯一顶层工作空间，固定一级 surfaces 可访问。
2. 单个 Project 可稳定管理至少 8 个实例，同 Provider 至少两个实例隔离并行。
3. 自由 split tree、Tab 唯一、N Panel、自动恢复和 1280×800 行为符合 UX。
4. 关闭 Tab、切换 Project、关闭窗口、退出、归档和删除没有生命周期歧义。
5. 外部事件、assistant 文本、恢复与导入均不能自动启动 Run。
6. Tasks/Knowledge、Attention、Handoff 和 Settings 是完整可操作 surface。

### 执行与安全

7. 每实例 Chat/Terminal 互斥，`turn-complete`/`process-exited` 边界正确。
8. RunStore 记录成功、失败、取消和中断；SessionStore 只记录成功回合。
9. worktree、diff、validation、drift 和 ff-only apply 按实例隔离。
10. 无法强制的权限阻止 Run；所有危险确认和外部 CRUD 可审计。
11. 浏览器/Connector 身份按连接隔离，secret/Cookie/Token 不泄漏到 Agent、
    renderer、store、日志或导出，原始 CLI 旁路被阻断。
12. 飞书 scope、版本冲突、多 Agent Dispatch 和用户最终验收可重复验证。
13. 退出 handoff、fallback snapshot、crash recovery 和无遗留子进程通过验证。

### 工程质量

14. schema/迁移幂等、可回滚，旧三槽数据不丢失或串实例。
15. `npm run typecheck && npm test && npm run build` 全部通过。
16. `git diff --check` 通过。
17. 三家真实 CLI E2E、飞书测试租户 E2E 和 Electron GUI smoke 有可重复记录；未运行
    的验证必须明确标注，不能用 fixture 结果代替。

## 14. 主要风险与控制

| 风险 | 控制 |
| --- | --- |
| v0.2 范围显著扩大 | 阶段纵切、明确 Later/Out、每阶段独立验收 |
| UI mock 演变成第二套业务逻辑 | 版本化 ports、contract tests、逐切片替换 adapter |
| ProviderId/InstanceId 混用 | branded types、IPC/event 强制字段、禁 Provider 特判 |
| split tree/drag 状态复杂 | 纯 reducer、不变量/property tests、键盘替代路径 |
| N 实例造成进程/额度失控 | 单实例 1、Project 3、Global 6 默认队列与可见预算 |
| 后台/退出遗留进程 | Electron 生命周期协调器、最终 handoff、crash recovery |
| 权限 UI 与实际能力不一致 | Doctor capability、effective policy、默认阻止 |
| 原生 auto-approve 绕过产品权限 | 最小 Broker 前置、真实 Run 门禁、默认拒绝 |
| 浏览器与 Connector 身份串线 | 按 ConnectionId 分区、keychain、Cookie 禁用桥接 |
| Agent 绕过 Connector 调已认证 CLI | 窄能力 RPC、profile 隔离、无法强制时不授予连接能力 |
| 飞书冲突或越权写入 | scope 交集、connector 二次验证、版本冲突、审计 |
| 多 worktree 磁盘膨胀 | 用量可见、归档、无自动清理、永久删除确认 |
| v0.1 迁移误绑 session/worktree | 事务备份、可验证映射、人工恢复清单、幂等测试 |
| 文档与实现漂移 | ADR/UX/PLAN/HANDOFF 同步、release gate 与 ticket 引用 |

## 15. 决策记录

已接受：

- [ADR-0007](./adr/0007-structured-chat-pty-terminal.md)：structured Chat 默认，PTY
  仅为 Terminal 接管；
- [ADR-0008](./adr/0008-project-first-agent-instances.md)：Project-first、N 个命名
  Agent、Provider/Instance 分离；
- [ADR-0009](./adr/0009-command-center-workspace-lifecycle.md)：单窗口指挥中心、自由
  split tree、显式执行、后台/退出/handoff 与归档；
- [ADR-0010](./adr/0010-feishu-integration-trust-boundaries.md)：飞书浏览器/CLI 身份
  隔离、Project scope、数据主权与风险确认；
- [ADR-0011](./adr/0011-ui-first-contract-driven-delivery.md)：设计冻结后先实现生产 UI
  和契约化 mock，再接 Project-first 内核。
- [ADR-0012](./adr/0012-enforced-execution-and-brokered-capabilities.md)：最小权限门禁早于
  真实 Run，飞书由受控 Connector 代执行官方 CLI 能力。
- [ADR-0013](./adr/0013-agent-squad-hq-product-identity.md)：正式产品名、稳定技术 slug、
  Electron 数据目录兼容与 GitHub 仓库身份。

## 16. 立即下一步

Phase 0 已完成。Phase 1 #1 已由 [PR #18](https://github.com/pcliangx/agent-squad-hq/pull/18)
实现（Project Shell + 版本化 WorkbenchPort + MockScenarioAdapter）。后续按
[`ui-first-command-center`](../.scratch/ui-first-command-center/spec.md) 和
[GitHub Issues #2–#16](https://github.com/pcliangx/agent-squad-hq/issues) 的剩余纵向 tracer
bullets 推进。工作顺序只由 GitHub Relationships 的原生 `blocked by` 决定，
不按编号机械串行。[产品身份迁移 #17](https://github.com/pcliangx/agent-squad-hq/issues/17)
已完成；收到用户明确指令后按以下 7 批 DAG 执行：

1. `01`：✅ 已完成（[PR #18](https://github.com/pcliangx/agent-squad-hq/pull/18)）；
2. `02, 03`：并行交付全局操作/确认宿主与 Agent Directory/唯一 Tab；
3. `04, 06, 08, 13`：并行交付基础布局、显式 Dispatch、Changes 与 Settings A；
4. `05, 07`：并行补齐高级布局与队列/Terminal 执行槽；
5. `09, 15`：并行交付 Permission/Global Attention 与 Electron 冒烟骨架；
6. `10, 11, 12, 14`：并行交付 Tasks、Knowledge、Handoff/退出和 Readiness；
7. `16`：统一完成可访问性、视觉与发布门禁。

前 14 票完成时功能 UI 完整，第 16 票通过后才正式认定 Phase 1 UI 完成。理论最大
并行度为 4；共享工作树默认串行接力，只有分配独立 worktree 并明确文件/模块边界后
才执行并行批次。Issue 范围、验收、labels、comments、状态和依赖只以 GitHub 为 truth，
不在 `.scratch/` 维护 ticket 副本。

Phase 1 不接入真实 ProjectStore、Agent、PTY、Git mutation、PermissionBroker、飞书
登录/CRUD 或其他外部副作用。UI 验收后再按 Phase 2 → 7 逐切片替换 mock adapter。
