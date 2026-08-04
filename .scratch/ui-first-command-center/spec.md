# Phase 1：生产 UI 与契约化 Mock 指挥中心

Type: spec
Status: accepted

## 问题陈述

Agent Squad HQ 当前已经验证三家 Agent Provider 的结构化通信、PTY 与 worktree 基础能力，
但产品界面仍以 Claude、Codex、Kimi 三个固定 pane 组织。用户无法以 Project 为顶层
创建和管理多个同类 Agent Instance，也无法在统一指挥中心中自由安排 Tab/Panel、
观察运行态势、显式派发工作、处理 Attention、浏览 Project 任务与知识，或清楚理解
配置和权限何时生效。

产品和视觉基线已经冻结，但真实 ProjectStore、实例 runtime、PermissionBroker 和飞书
集成尚未具备。若直接把这些后端能力接入旧界面，旧的 Provider-first 心智会继续渗入
领域模型；若先制作另一套拥有独立业务规则的静态 UI，接入真实数据时又会整体重写。

本阶段需要一套生产级、可测试、无真实副作用的 UI 基线。它必须准确表达已经接受的
Project-first 领域契约，并通过与未来真实 adapter 共用的边界工作，而不是把
throwaway prototype、Provider 固定槽或 mock 内部状态当成产品 truth。

## 解决方案

在正式 React/TypeScript renderer 中实现 Project-first 集成工作台与指挥中心，由版本化
的 `WorkbenchPort` 向 UI 提供 ViewModel、接收 Command 并推送 Event。Phase 1 使用纯
内存 `MockScenarioAdapter` 驱动全部关键状态；未来真实 main/preload adapter 必须遵守
同一合同并通过同一 contract suite。

指挥中心采用已冻结的唯一组合：

- A 双侧栏是常态骨架，固定 Project 一级导航和当前工作面的上下文目录；
- B 运行雷达是可展开的全局态势与 Attention 抽屉，不维护第二套导航；
- C Agent Directory 只在 Focus 或窄窗口中作为 palette；
- Settings A 是唯一完整编辑器，B 是实例有效配置比较视图，C 是下一次 Run 的
  readiness 摘要。

UI 覆盖 Project 导航、Overview、Agents、Tasks、Knowledge、Handoffs、Activity、
Settings、Global Attention、自由 split tree、Panel/Tab、Agent Picker、Dispatch
预览、配置 draft/applied 和全部关键状态。所有数据和结果均来自 port；mock 不启动
Agent、不操作 Git、不登录飞书、不持久化正式 truth，也不执行任何外部副作用。

## 用户故事

1. 作为多 Agent 用户，我希望 Project 是唯一顶层工作空间，从而不会把 Provider、
   仓库、任务或某个聊天窗误认为产品边界。
2. 作为 Project 负责人，我希望进入 Project 后看到名称、根目录状态、Git readiness、
   连接状态和 Attention 摘要，从而立即理解当前可用能力。
3. 作为回访用户，我希望重新进入 Project 时回到上次工作面和布局，从而继续先前工作
   而不必重新组织界面。
4. 作为新 Project 用户，我希望首次进入 Overview，从而先理解项目边界再开始工作。
5. 作为本地工作用户，我希望未连接飞书时仍能使用 Agents、本地 Tasks、Handoffs 和
   Activity，从而不会因可选集成缺失而失去整个 Project。
6. 作为非 Git Project 用户，我希望继续管理任务和知识，同时明确看到 Agent
   execution 尚未 ready，从而不会把局部限制误认为 Project 不可用。
7. 作为 Project 负责人，我希望 root 丢失时看到独立的 Root unavailable 状态和修复
   入口，从而保留历史并理解真正的阻断原因。
8. 作为用户，我希望 Overview、Agents、Tasks、Knowledge、Handoffs、Activity 和
   Settings 始终通过固定一级导航访问，从而建立稳定的空间记忆。
9. 作为同时管理多个 Project 的用户，我希望 Global Attention 独立于当前 Project
   surface，从而不会漏掉后台 Project 的待处理事项。
10. 作为用户，我希望切换 Project 不自动启动或停止 Run，从而保持执行动作完全显式。
11. 作为多 Agent 用户，我希望 Agent Directory 展示 Project 内全部实例，而不只是已
    打开的 Tab，从而能管理后台和未打开实例。
12. 作为用户，我希望按名称、Provider、状态和最近活动搜索或过滤 Agent，从而在至少
    8 个实例中快速定位目标。
13. 作为用户，我希望 Agent Name 是主标题、Provider 是次级信息，从而以实例角色而
    不是厂商理解协作成员。
14. 作为用户，我希望同一个 Provider 可以出现多个独立命名实例，从而按数据、SQL、
    审阅或可视化角色拆分工作。
15. 作为用户，我希望点击已有实例时聚焦其唯一 Tab，从而不会无意创建镜像或重复视图。
16. 作为用户，我希望打开未显示的实例时选择当前 Panel、新 Panel 或后台，从而控制
    工作区密度。
17. 作为用户，我希望 Unavailable Agent 仍显示历史、handoff、任务和改动摘要，从而
    在 Provider 故障时不丢失上下文。
18. 作为用户，我希望新建 Agent 时只看到 Doctor ready 的 Provider，从而不会创建
    一个注定无法运行的实例。
19. 作为用户，我希望创建 Agent 只产生 Ready 实例而不自动运行，从而先检查配置和
    工作区再产生执行成本。
20. 作为用户，我希望 Agent View 内统一提供 Chat、Activity、Changes 和 Terminal，
    从而在同一实例上下文中切换观察方式。
21. 作为用户，我希望 Agent Tab composer 明确只作用于当前实例，从而无需重复选择
    已经由 Tab 确定的目标。
22. 作为用户，我希望关闭 Agent Tab 只关闭视图，从而不意外停止 Run、PTY、Session
    或删除实例。
23. 作为用户，我希望 Tab 展示 Agent Name、Provider、运行状态和未读/待处理标记，
    从而无需进入内容区就能判断态势。
24. 作为用户，我希望一个 Panel 可以容纳多个 Tab，从而在有限屏幕中快速切换实例。
25. 作为用户，我希望把 Tab 拖到另一个 Panel 中部，从而移动实例视图而不复制它。
26. 作为用户，我希望把 Tab 拖到 Panel 四个边缘创建新分屏，从而按任务需要自由重组
    工作区。
27. 作为用户，我希望显式向右或向下 Split 当前 Panel，从而不依赖精确拖放也能创建
    布局。
28. 作为用户，我希望拖动 divider 自由调整分割比例，从而把空间分配给当前重点。
29. 作为键盘用户，我希望用键盘激活和移动 Tab、调整 divider，从而完成与鼠标等价的
    核心布局操作。
30. 作为用户，我希望临时 Focus 一个 Panel 后无损恢复 split tree，从而专注当前工作
    又不破坏布局。
31. 作为分析用户，我希望应用“一主两辅”布局预设，从而快速形成常见观察结构而不引入
    第二套布局模型。
32. 作为使用小屏幕的用户，我希望 1280×800 下 1–3 个 Panel 保持可用，从而看清主要
    信息和操作。
33. 作为高级用户，我希望创建第 4 个及更多 Panel 时只收到非阻断提示，从而保留自由
    分割原则。
34. 作为使用多 Panel 的用户，我希望空间不足时出现明确滚动、折叠或溢出处理，从而
    Panel 不会被压缩到不可操作。
35. 作为用户，我希望关闭最后一个 Tab 后空 Panel 被安全裁剪，从而布局不会积累无用
    空节点。
36. 作为用户，我希望关闭含多个 Tab 的 Panel 前选择目标 Panel，从而不会隐式丢失
    视图归属。
37. 作为用户，我希望布局变化自动保存，而身份、权限和运行配置不随布局动作改变，从而
    视图状态与业务状态保持分离。
38. 作为用户，我希望从 Overview、Tasks 工作面、Handoff 或命令入口打开统一
    Agent Picker，从而所有非 Tab 派发都使用同一种目标选择方式。
39. 作为用户，我希望 Picker 把选择结果显示为具体 Agent chips，从而在发送前看清
    每个目标实例。
40. **US-040** 作为高级用户，我希望 `@@<agent-name>` 被解析为可见 chips，从而兼顾
    键盘效率和目标透明度。
41. **US-041** 作为高级用户，我希望 `@@all` 展开为当前 Project 的明确实例列表并
    再次确认，从而避免不可见广播。
42. **US-042** 作为用户，我希望 assistant 文本中的 `@@` 永远只是文本，从而外部
    输出不会触发新执行。
43. 作为用户，我希望 Dispatch 前预览指令、资源范围、目标和队列位置，从而理解即将
    发生的动作。
44. 作为用户，我希望每个目标生成独立 Dispatch 表示，从而多 Agent 工作不会混成一条
    不可追踪的执行。
45. 作为用户，我希望 Agent 已有 active Run 时新工作显示为当前等待 Run 的回复或下一
    Run 队列，从而不会误以为同一实例并发运行两次。
46. 作为用户，我希望队列状态和深度可见，从而理解指令为何尚未开始。
47. 作为用户，我希望取消尚未执行的 mock Dispatch，从而验证队列管理交互。
48. 作为用户，我希望运行、排队、needs-input、permission-requested、失败、中断和完成
    使用不同文字与操作，从而不依赖颜色猜测状态。
49. 作为用户，我希望从任意 Project surface 和 Settings 打开 Global Attention，从而
    始终能处理紧急事项。
50. 作为用户，我希望点击 Attention Item 深链到对应 Project、Agent、Run、
    Project Task、External Task、Knowledge 或 Handoff，从而直接进入问题上下文。
51. 作为用户，我希望处理后的 Attention 从待办列表移除但仍可在 Activity 中查看，
    从而兼顾清理和审计。
52. 作为 Project 负责人，我希望 Overview 汇总 Agent、Run、权限、连接、worktree 和
    handoff 态势，从而快速决定下一步。
53. 作为任务负责人，我希望 Tasks 区分本地 Project Task、飞书任务投影、Dispatch、
    Execution Result 和最终验收，从而不会把 Run 完成误认为业务任务完成。
54. 作为任务负责人，我希望同一 External Task 可以模拟派给多个 Agent 并分别查看
    结果，从而验证并行协作体验。
55. 作为任务负责人，我希望外部任务变化只产生投影更新或 Attention，从而不会自动
    启动 Agent。
56. 作为知识用户，我希望 Knowledge 展示受控浏览器容器的 online、offline、
    unavailable 和缓存状态，从而理解内容是否实时可编辑。
57. 作为知识用户，我希望 UI 分别展示人工浏览器身份和 Connector 执行身份，从而不会
    误以为两者共享 Cookie 或授权。
58. 作为知识用户，我希望未连接飞书时看到可操作的连接引导和本地能力说明，从而知道
    哪些功能仍可使用。
59. 作为协作者，我希望 Handoffs 展示来源、目标、完整性、改动摘要和验证结果，从而
    判断交接是否足够可靠。
60. 作为协作者，我希望不完整 handoff 明确显示原因和恢复动作，从而不会把 fallback
    snapshot 当作完整交接。
61. 作为审计用户，我希望 Activity 按时间展示 Run、权限、工具、外部操作、配置和生命
    周期事件，从而追踪发生了什么。
62. 作为 Project 管理员，我希望 Settings 保留 Project 导航与 Global Attention，
    从而配置时不脱离指挥中心。
63. 作为 Project 管理员，我希望 General、Agent Defaults、Agent Instances、
    Integrations、Permissions 和 Storage 使用稳定目录，从而快速找到配置。
64. 作为 Project 管理员，我希望 Settings A 是唯一完整编辑入口，从而 B/C 不会形成
    相互冲突的编辑逻辑。
65. 作为 Project 管理员，我希望 B 策略矩阵只比较多个实例的 applied/effective
    配置，从而快速发现差异。
66. 作为 Project 管理员，我希望 C readiness 只总结下一次 Run 能否安全启动并链接
    回完整设置，从而不会在摘要中遗漏重要配置。
67. 作为 Project 管理员，我希望 Project 与每个 Agent Instance 的同名设置按稳定
    owner ID 隔离，从而一个实例的草稿不会修改另一个实例。
68. 作为 Project 管理员，我希望编辑字段只产生 draft，从而当前 applied 配置和 active
    Run 不会被静默改变。
69. 作为 Project 管理员，我希望 Discard 恢复全部 applied 值，从而可以安全放弃一组
    未应用更改。
70. 作为 Project 管理员，我希望 Apply 前看到变更摘要，并以一次原子提交更新相关
    owner 的 applied version，从而不会出现只生效一半的配置。
71. 作为 Project 管理员，我希望模型、权限、代理、环境、资源范围、并发和预算只影响
    下一次 Run，从而当前 Run 保持可复现。
72. 作为 Project 管理员，我希望飞书主连接支持空值或一个 ConnectionId，从而外部集成
    保持可选且身份边界清楚。
73. 作为安全敏感用户，我希望权限页面只展示可强制的 effective policy，从而不会把
    worktree、prompt 或原生 bypass 误认为 sandbox。
74. 作为安全敏感用户，我希望不可强制的策略显示为 blocked，而不是可勾选的虚假保护，
    从而在真实执行接入前保持正确心智。
75. 作为安全敏感用户，我希望删除、批量、成员、权限、凭据、丢弃和合并等高风险确认
    显示为不可绕过，从而不会因普通权限设置被关闭。
76. 作为用户，我希望 empty、loading、ready、queued、running、needs-input、
    permission-requested、failed、interrupted、conflict、offline、unavailable 和
    archived 都有独立可操作状态，从而异常和降级路径与 happy path 同样完整。
77. 作为键盘用户，我希望导航、Tab、Panel、Picker、Attention、Settings 和 modal
    拥有可预测焦点顺序，从而无需鼠标完成主要任务。
78. 作为辅助技术用户，我希望状态拥有文本和可访问名称，从而颜色不是唯一信息来源。
79. 作为减少动态效果的用户，我希望关键操作不依赖动画完成，从而界面在减少动效偏好
    下仍然清楚可用。
80. 作为产品评审者，我希望切换标准 mock scenario 就能重现关键状态组合，从而不依赖
    真实 CLI、凭据、网络或人工造数据。
81. 作为跨 Project 用户，我希望从全局层进入 Connections，从而查看可用连接而不把
    凭据或连接生命周期误放进单个 Project。
82. 作为多 Provider 用户，我希望全局层持续显示 Provider Health，从而在进入某个
    Agent 前就知道哪些 Provider 可用或需要修复。
83. 作为应用用户，我希望全局设置与 Project Settings 使用不同入口，从而不会把应用级
    连接、通知和外观配置误认为 Project 配置。
84. 作为应用用户，我希望关闭窗口和显式“退出 Agent Squad HQ”是不同动作，从而能够预览
    活动 Run、Terminal 与 handoff-dirty 状态，而不会意外结束后台工作。
85. 作为多 Agent 用户，我希望 mock 指挥台展示每实例 1、Project 3、Global 6 的活动
    Run 上限及超限队列，从而在真实 runtime 接入前理解并发边界。
86. 作为队列管理者，我希望重排优先级、取消尚未执行项并看到队列位置变化，从而控制
    哪项工作先开始。
87. 作为 Terminal 用户，我希望 Terminal Takeover 占用对应实例执行槽并阻止
    structured Run，从而不会看到同一实例同时运行两条冲突路径。
88. 作为收到权限请求的用户，我希望选择拒绝、允许一次或允许当前 Run，从而授权范围
    清楚且不会被默认为永久授权。
89. 作为安全敏感用户，我希望权限请求超时自动显示为拒绝，永久策略修改只链接到
    Settings，从而临时批准不会扩大长期权限。
90. 作为 Handoff 接收者，我希望被动导入只创建可检查的 Handoff，而“导入并执行”必须
    经过目标预览和显式确认，从而导入本身不会自动启动 Run。
91. 作为重命名 Agent 的用户，我希望 Apply 成功后 Agent Name 和路由元数据立即生效，
    而模型、权限、代理、环境、资源、并发和预算只影响下一次 Run，从而生效时机明确。
92. 作为调整布局的用户，我希望布局命令因 revision 过期或不变量被拒绝时回到最新权威
    布局并看到恢复提示，从而不会保留与 adapter 不一致的幽灵 Panel 或 Tab。
93. 作为执行高风险模拟操作的用户，我希望看到动作、目标、影响、不可绕过原因和最终
    确认结果，从而完整验证确认流程，而不只是看见一个 modal 外壳。

## 实现决定

- Phase 1 只建设生产 renderer、交互状态和契约化 mock，不接入真实后端副作用。
- 正式产品名、技术 slug 和兼容标识遵循
  [ADR-0013](../../docs/adr/0013-agent-squad-hq-product-identity.md)；UI 必须显示完整的
  “Agent Squad HQ”，不能省略 `HQ`。
- `WorkbenchPort` 是 renderer 的唯一业务接缝。它负责提供版本化 ViewModel 快照、
  接收类型化 Command、推送 Event，并返回明确的命令成功或拒绝结果。
- `MockScenarioAdapter` 与未来真实 adapter 实现同一 port。mock 只重放场景和可预测
  状态转换，不持久化正式 truth，也不复制 main/domain 才能判定的安全规则。

### 最小 TypeScript 合同

以下类型形状由 Phase 0 原型中的最小合同收敛而来，是
[GitHub Issue #1](https://github.com/pcliangx/agent-squad-hq/issues/1) 必须实现的下限；允许
增加字段，但不能删除稳定 ID、revision、correlation、拒绝原因或已冻结状态语义。

```ts
type Brand<T, Name extends string> = T & { readonly __brand: Name }

type ProjectId = Brand<string, 'ProjectId'>
type AgentProviderId = Brand<string, 'AgentProviderId'>
type AgentInstanceId = Brand<string, 'AgentInstanceId'>
type RunId = Brand<string, 'RunId'>
type DispatchId = Brand<string, 'DispatchId'>
type HandoffId = Brand<string, 'HandoffId'>
type ConnectionId = Brand<string, 'ConnectionId'>
type PanelId = Brand<string, 'PanelId'>
type SplitNodeId = Brand<string, 'SplitNodeId'>
type AttentionItemId = Brand<string, 'AttentionItemId'>
type CommandId = Brand<string, 'CommandId'>
type PermissionRequestId = Brand<string, 'PermissionRequestId'>
type ConfirmationId = Brand<string, 'ConfirmationId'>
type QueueItemId = Brand<string, 'QueueItemId'>
type ExternalResourceId = Brand<string, 'ExternalResourceId'>
type ProjectTaskId = Brand<string, 'ProjectTaskId'>
type ExternalTaskId = Brand<string, 'ExternalTaskId'>
type KnowledgeResourceId = Brand<string, 'KnowledgeResourceId'>

type ProjectSurface =
  | 'overview' | 'agents' | 'tasks' | 'knowledge'
  | 'handoffs' | 'activity' | 'settings'
type ProjectLifecycle = 'active' | 'archived'
type RootAvailability = 'available' | 'unavailable'
type RepositoryReadiness = 'ready' | 'not-ready'
type AgentRuntimeState =
  | 'ready' | 'queued' | 'starting' | 'running' | 'finishing'
  | 'needs-input' | 'permission-requested'
  | 'failed' | 'cancelled' | 'interrupted' | 'unavailable' | 'archived'
type TerminalState = 'closed' | 'opening' | 'active' | 'failed'
type PermissionDecision = 'deny' | 'allow-once' | 'allow-current-run'
type GlobalSurface = 'connections' | 'provider-health' | 'global-settings'

type LayoutNode =
  | { kind: 'panel'; panelId: PanelId }
  | {
      kind: 'split'
      splitNodeId: SplitNodeId
      direction: 'horizontal' | 'vertical'
      ratio: number
      first: LayoutNode
      second: LayoutNode
    }

interface WorkspaceLayoutViewModel {
  root: LayoutNode | null
  panels: Record<PanelId, {
    tabs: AgentInstanceId[]
    activeTabId?: AgentInstanceId
  }>
  focusedPanelId?: PanelId
  temporaryFocusPanelId?: PanelId
}

interface ProjectViewModel {
  projectId: ProjectId
  name: string
  lifecycle: ProjectLifecycle
  rootAvailability: RootAvailability
  repositoryReadiness: RepositoryReadiness
  activity: 'idle' | 'active'
  activeRunCount: number
  queuedRunCount: number
  attentionCount: number
  primaryConnectionId?: ConnectionId
  currentSurface: ProjectSurface
  layout: WorkspaceLayoutViewModel
}

interface AgentInstanceViewModel {
  agentInstanceId: AgentInstanceId
  projectId: ProjectId
  name: string
  providerId: AgentProviderId
  runtimeState: AgentRuntimeState
  terminalState: TerminalState
  activeRunId?: RunId
  queueDepth: number
  doctor: 'ready' | 'blocked'
}

type ConfigurationOwner =
  | { kind: 'project'; projectId: ProjectId }
  | { kind: 'agent'; agentInstanceId: AgentInstanceId }

interface ConfigurationDraftViewModel {
  owner: ConfigurationOwner
  appliedVersion: number
  changes: Array<{ fieldPath: string; applied: unknown; draft: unknown }>
  validationErrors: Array<{ fieldPath?: string; message: string }>
}

interface QueueItemViewModel {
  queueItemId: QueueItemId
  projectId: ProjectId
  agentInstanceId: AgentInstanceId
  position: number
  priority: 'low' | 'normal' | 'high'
}

interface PermissionRequestViewModel {
  requestId: PermissionRequestId
  projectId: ProjectId
  agentInstanceId: AgentInstanceId
  runId: RunId
  reason: string
  expiresAt: number
  decisions: PermissionDecision[]
}

type AttentionTarget =
  | { kind: 'project'; projectId: ProjectId }
  | { kind: 'agent'; projectId: ProjectId; agentInstanceId: AgentInstanceId }
  | { kind: 'run'; projectId: ProjectId; agentInstanceId: AgentInstanceId; runId: RunId }
  | { kind: 'project-task'; projectId: ProjectId; projectTaskId: ProjectTaskId }
  | { kind: 'external-task'; projectId: ProjectId; externalTaskId: ExternalTaskId }
  | { kind: 'knowledge'; projectId: ProjectId; knowledgeResourceId: KnowledgeResourceId }
  | { kind: 'handoff'; projectId: ProjectId; handoffId: HandoffId }

interface AttentionItemViewModel {
  attentionItemId: AttentionItemId
  target: AttentionTarget
  state: 'open' | 'resolved'
  title: string
}

interface ConfirmationViewModel {
  confirmationId: ConfirmationId
  action: string
  target: string
  impact: string
  nonBypassableReason: string
}

interface WorkbenchViewModel {
  schemaVersion: 1
  revision: number
  activeProjectId?: ProjectId
  activeGlobalSurface?: GlobalSurface
  projects: ProjectViewModel[]
  agents: AgentInstanceViewModel[]
  queue: QueueItemViewModel[]
  permissionRequests: PermissionRequestViewModel[]
  attentionItems: AttentionItemViewModel[]
  pendingConfirmation?: ConfirmationViewModel
  configurationDrafts: ConfigurationDraftViewModel[]
  global: {
    attentionCount: number
    concurrency: {
      perAgentLimit: 1
      projectLimit: 3
      globalLimit: 6
      activeGlobal: number
      queuedGlobal: number
    }
    connections: Array<{
      connectionId: ConnectionId
      label: string
      status: 'connected' | 'disconnected' | 'offline' | 'error'
    }>
    providers: Array<{ providerId: AgentProviderId; status: 'ready' | 'blocked' }>
  }
}

interface CommandMeta {
  commandId: CommandId
  expectedRevision: number
}

type LayoutOperation =
  | { kind: 'open-tab'; panelId: PanelId; agentInstanceId: AgentInstanceId }
  | { kind: 'activate-tab'; panelId: PanelId; agentInstanceId: AgentInstanceId }
  | { kind: 'close-tab'; panelId: PanelId; agentInstanceId: AgentInstanceId }
  | { kind: 'move-tab'; agentInstanceId: AgentInstanceId; targetPanelId: PanelId }
  | { kind: 'split-panel'; panelId: PanelId; direction: 'horizontal' | 'vertical' }
  | { kind: 'resize-split'; splitNodeId: SplitNodeId; ratio: number }
  | { kind: 'focus-panel'; panelId?: PanelId }
  | { kind: 'prune-empty-panels' }

type WorkbenchCommand = CommandMeta & (
  | { kind: 'navigate-global'; surface: GlobalSurface }
  | { kind: 'navigate'; projectId: ProjectId; surface: ProjectSurface }
  | { kind: 'change-layout'; projectId: ProjectId; operation: LayoutOperation }
  | {
      kind: 'send-agent-instruction'
      projectId: ProjectId
      agentInstanceId: AgentInstanceId
      instruction: string
      mode: 'start-or-queue' | 'reply-current-run'
    }
  | {
      kind: 'set-terminal-takeover'
      projectId: ProjectId
      agentInstanceId: AgentInstanceId
      operation: 'open' | 'close'
    }
  | {
      kind: 'confirm-dispatch'
      projectId: ProjectId
      targets: AgentInstanceId[]
      instruction: string
    }
  | {
      kind: 'manage-queue'
      projectId: ProjectId
      queueItemId: QueueItemId
      operation: 'cancel' | 'move-earlier' | 'move-later' | 'raise-priority' | 'lower-priority'
    }
  | {
      kind: 'answer-permission'
      projectId: ProjectId
      agentInstanceId: AgentInstanceId
      runId: RunId
      requestId: PermissionRequestId
      decision: PermissionDecision
    }
  | { kind: 'resolve-attention'; attentionItemId: AttentionItemId }
  | { kind: 'stage-configuration'; owner: ConfigurationOwner; fieldPath: string; value: unknown }
  | { kind: 'discard-configuration'; owners: ConfigurationOwner[] }
  | {
      kind: 'apply-configuration'
      owners: Array<{ owner: ConfigurationOwner; expectedAppliedVersion: number }>
    }
  | {
      kind: 'import-handoff'
      projectId: ProjectId
      handoffId: HandoffId
      targetAgentInstanceId: AgentInstanceId
      mode: 'inspect-only'
    }
  | {
      kind: 'import-handoff'
      projectId: ProjectId
      handoffId: HandoffId
      targetAgentInstanceId: AgentInstanceId
      mode: 'execute-confirmed'
      confirmationId: ConfirmationId
    }
  | { kind: 'request-quit-preview' }
  | { kind: 'confirm-dangerous-action'; confirmationId: ConfirmationId }
)

type CommandRejectionReason =
  | 'stale-revision' | 'invalid-target' | 'invariant-violation'
  | 'unavailable' | 'busy' | 'confirmation-required'
  | 'not-enforceable' | 'scenario-read-only'

type LayoutTargetEffect =
  | { kind: 'selected-agent'; agentInstanceId: AgentInstanceId | null }
  | {
      kind: 'closed-agent'
      agentInstanceId: AgentInstanceId
      selectedAgentInstanceId?: AgentInstanceId | null
    }

type CommandResult =
  | {
      ok: true
      commandId: CommandId
      acceptedRevision: number
      layoutTargetEffect?: LayoutTargetEffect
    }
  | {
      ok: false
      commandId: CommandId
      reason: CommandRejectionReason
      latestRevision: number
      message: string
    }

type WorkbenchEvent =
  | {
      kind: 'view-model-updated'
      revision: number
      correlationId?: CommandId
      snapshot: WorkbenchViewModel
    }
  | {
      kind: 'run-state-changed'
      revision: number
      projectId: ProjectId
      agentInstanceId: AgentInstanceId
      runId: RunId
      state: AgentRuntimeState
    }
  | {
      kind: 'permission-requested'
      revision: number
      projectId: ProjectId
      agentInstanceId: AgentInstanceId
      runId: RunId
      requestId: PermissionRequestId
    }
  | {
      kind: 'dispatch-created'
      revision: number
      correlationId: CommandId
      dispatchIds: DispatchId[]
    }
  | {
      kind: 'attention-changed'
      revision: number
      attentionItemId: AttentionItemId
      state: 'open' | 'resolved'
    }
  | {
      kind: 'configuration-applied'
      revision: number
      correlationId: CommandId
      owners: Array<{ owner: ConfigurationOwner; appliedVersion: number }>
    }
  | {
      kind: 'handoff-imported'
      revision: number
      correlationId: CommandId
      handoffId: HandoffId
      mode: 'inspect-only' | 'execute-confirmed'
    }
  | {
      kind: 'external-state-changed'
      revision: number
      projectId: ProjectId
      resourceId: ExternalResourceId
      state: 'offline' | 'conflict' | 'unavailable'
    }
  | { kind: 'command-rejected'; revision: number; result: Extract<CommandResult, { ok: false }> }

interface WorkbenchPort {
  getSnapshot(): Promise<WorkbenchViewModel>
  dispatch(command: WorkbenchCommand): Promise<CommandResult>
  subscribe(listener: (event: WorkbenchEvent) => void): () => void
}
```

- ViewModel 只表达已经由 adapter 判定的事实。renderer 不从文案、ANSI、Provider
  名称或对象缺失推导业务状态。
- `WorkbenchViewModel.revision` 单调递增，是 renderer 可见业务状态的唯一权威版本。
  `CommandId` 负责幂等与相关性，Command 携带 `expectedRevision`；响应与 Event 的到达
  先后不作假设，renderer 只接受 revision 更新的快照，并能安全忽略重复或过期结果。
- 所有领域对象使用稳定、不可互换的品牌化 ID。Provider registry 以
  AgentProviderId 识别能力；Tab、Panel、runtime 和命令目标使用 AgentInstanceId
  或各自领域 ID。
- Project lifecycle、root availability、repository readiness、activity 和 Attention
  是正交维度。未连接飞书、未初始化 Git 或单个 Provider 故障只降级相关能力。
- 单窗口信息架构固定为 Project switcher、Global Attention、Global Connections、
  Provider Health、全局设置与显式退出入口，以及 Project 一级导航、当前 surface
  上下文目录和主内容区。
- A 双侧栏是唯一常态主结构；B 雷达和 C palette 复用同一 ViewModel、Command 与导航
  状态，不建立第二套业务树。
- Workspace Layout 的 canonical UI 形状是递归 split tree。内部节点持有方向、比例和
  两个子节点，叶节点引用 Panel；Panel 持有 AgentInstanceId Tab 列表和活动 Tab。
- Layout reducer 是 port 后面的共享纯状态转换，也是 mock 与未来真实 adapter 的唯一
  结构布局转换。它维护 Tab 全窗口唯一、Tab 单 Panel 归属、有效比例、空 Panel 裁剪、
  Focus 可逆和无悬空 Panel 引用等不变量；不得在 renderer 与 adapter 各复制一套 reducer。
- 接受 `change-layout`，或 `create-agent` 以当前/新 Panel 打开实例时，同一 reducer 可在
  `CommandResult.layoutTargetEffect` 返回权威的 Agent 选择/关闭后果。renderer 只能按
  命令意图顺序结算这些 effect，不得根据旧布局重演 reducer；拒绝结果和无 target
  effect 的结构操作都不改变已保留的深链目标。更新的 deep link 在导航阶段作为 pending
  target intent；发出 Agent layout 命令时必须无缝转交为该命令的 intent。后续操作可以
  取消深链 UI continuation，但不能丢弃已发出命令仍待结算的权威 effect，避免旧 Result
  越过已到达的新 Event 清除目标；该 intent 同时携带完整新 deep-link 目标，因此同一
  Agent 的不同 Run 或 Agent 级目标也能替换旧 Run。显式离开当前上下文的导航同样按
  intent 顺序结算：仅接受且仍为当前意图时清除目标、notice 或 one-shot section 状态，
  拒绝或已被更新意图取代时保持原上下文。
- renderer 只允许在 pointer/keyboard 操作进行中保存临时视觉预览；结构变更在提交
  `change-layout` 后以 port 新快照为准。`stale-revision` 或不变量拒绝会丢弃预览、恢复
  最新权威布局并显示可恢复提示。
- 拖放、菜单与键盘命令最终归一化为同一组 layout Command，避免为输入方式复制逻辑。
- 1–3 Panel 是默认密度而非上限。4+ Panel 继续创建并给出非阻断提示；空间不足通过
  显式滚动、折叠或溢出处理。
- Agent Tab composer 的目标由当前 AgentInstanceId 隐式确定。其他入口的目标语义
  统一遵循 US-040 至 US-042，不另建一套 `@@` 解析规则。
- Assistant 输出、应用恢复、外部事件、被动 Handoff 导入和 Project 切换不能产生
  启动 Run 的 Command。用户预览目标并确认“导入并执行”后，可以显式创建目标 Run。
- 每个 Agent Instance 最多一个 active structured Run。已有 Run 时，新指令必须被
  建模为等待中 Run 的回复或下一 Run 队列项。
- mock 必须表达每实例 1、Project 3、Global 6 的默认活动 Run 上限；超限项进入可见
  队列，支持重排、优先级与取消。Terminal Takeover 占用实例执行槽并与 structured
  Run 互斥。
- Dispatch 预览包含具体目标、指令、资源范围和队列位置；确认后每个目标形成独立
  Dispatch 表示。
- Global Attention 是跨 Project 的操作投影，不是新的数据 truth。Item 必须携带稳定
  deep-link 目标，处理后仍可在 Activity 投影中查看。
- Tasks 将 External Task、Project Task、Dispatch、Run、Execution Result 和用户验收
  分开显示。任何模拟完成都不能自动改变外部任务的最终业务状态。
- Knowledge 在本阶段只提供浏览器容器 chrome、身份边界和状态反馈，不创建真实
  BrowserView、partition、登录或导航策略。
- `permission-requested` 是可操作状态：动作只有拒绝、允许一次、允许当前 Run；超时
  模拟为拒绝，永久策略只提供进入 Settings 的导航，不在请求弹窗中创建永久授权。
- Settings 的自动保存状态仅限布局、surface、过滤器、输入草稿和展开状态。身份、
  模型、权限、代理、环境、资源、并发和预算使用 draft/apply。
- Configuration Draft 以 ProjectId 或 AgentInstanceId owner 加 field path 标识；
  applied version、applied value 与 draft value 必须分别表达。
- Discard 只清除 draft 并恢复 applied。一次 Apply 对所列 owners 原子提交：全部验证
  通过后才分别增加 applied version；任一失败都不改变任何 applied value，保留草稿并
  显示字段级或表单级拒绝原因。
- Apply 成功后 Agent Name 与路由元数据立即生效；模型、权限、代理、环境、资源范围、
  并发和预算只影响下一次 Run，active Run 继续使用启动时快照。
- B 策略矩阵只读取 applied/effective 配置；C readiness 只汇总结果并导航到 A 的完整
  编辑位置。
- Project 主 External Connection 是可选的 0..1 ConnectionId。人工浏览器身份、
  Connector 执行身份、Project Resource Binding 和 Run instruction 必须分别呈现。
- 权限 UI 只显示 adapter 提供的 effective/enforced 状态。无法强制时显示 blocked；
  Phase 1 不声称已提供真实 PermissionBroker。
- 删除、批量、成员、权限、凭据、丢弃、合并、force 和 overwrite 等不可绕过确认在
  mock 中使用同一 confirmation contract 完整演示动作、目标、影响、确认和结果，但不
  执行真实动作。
- Mock scenarios 至少覆盖：空 Project、标准 8 Agent 指挥台、4+ Panel、排队、
  Project/Global 并发上限、Terminal 占槽、needs-input、permission-requested、权限超时、
  失败、中断、Provider unavailable、root unavailable、未初始化 Git、未连接飞书、
  offline cache、外部冲突、不完整 Handoff、被动导入/显式执行、Settings 多 owner
  原子 Apply 和 readiness blocked。
- 所有错误和 Command rejection 使用可枚举原因与面向用户的恢复动作，不以任意异常
  字符串作为 UI 分支条件。
- 生产 UI 不直接复制 throwaway HTML。原型只提供视觉层级、交互意图和经过确认的状态
  样例；正式组件使用仓库设计 token、正式状态合同和测试实现。
- Phase 1 不以 localStorage 作为 Project、Layout 或配置的 canonical state。需要展示
  恢复行为时由 mock adapter 提供确定性场景。

## 测试决定

- 好测试从用户或 port 消费者可观察的行为出发：给定 ViewModel/Event 或用户动作，
  断言可见内容、可访问状态、产生的 Command 和最终 ViewModel；不锁定组件内部 state、
  CSS class、DOM 层级或私有 helper。
- 主测试接缝是 renderer 与 `WorkbenchPort`。同一 contract suite 验证
  `MockScenarioAdapter`，并在后续阶段原样用于真实 main/preload adapter。
- Contract suite 验证 snapshot schema/revision、CommandId 幂等、correlation、响应与
  Event 任意先后、稳定 ID、拒绝原因、unsubscribe、过期结果忽略和无副作用保证。
- UI 集成测试通过 MockScenarioAdapter 驱动完整 Project surface，而不是逐层 mock
  组件。测试从可访问角色/名称执行导航、派发、配置和布局动作，并观察 port Command。
- split-tree reducer 是唯一额外算法接缝。使用示例测试和 property/invariant tests
  覆盖任意合法命令序列后的 Tab 唯一、Panel 引用、比例范围、空节点裁剪、Focus 恢复
  和命令拒绝；额外验证临时预览在 stale revision 后恢复权威快照，不测试具体递归实现。
- Electron 是发布护栏而不是第二套业务 seam。Phase 1 必须建立可重复运行的
  `npm run test:ui`，固定 1280×800 覆盖三个 Panel、第四 Panel 溢出、六个辅助视图、
  全局入口与 Attention、Picker/Dispatch、权限处理、Settings draft/apply/discard 和
  主要键盘路径；失败时保留截图、console 与步骤日志作为可检查产物。
- 视觉回归覆盖冻结的 A 主结构、B 抽屉/比较视图、C palette/readiness，以及
  empty、loading、offline、conflict、unavailable 和 modal 状态。
- 可访问性测试覆盖 landmarks、tablist/tab、dialog、divider、可访问名称、焦点进入/
  返回、Escape、箭头键、非指针拖放替代路径和状态非颜色表达。
- 设置测试至少使用两个 AgentInstanceId 修改相同 field path，证明 owner 隔离；
  同时验证 Discard 不改变 applied、Apply 对所有 owners 原子提交、失败保留全部草稿、
  Agent Name/路由立即生效、运行配置只影响下一 Run，且 active Run 快照不改变。
- Dispatch 测试引用 US-040 至 US-042，验证预览后才确认、每个目标独立 Command、
  active Run 进入队列，以及 assistant 文本不会产生 Command。
- 队列测试覆盖每实例 1、Project 3、Global 6，重排、优先级、取消及 Terminal 占槽，
  并证明这些 mock 状态不会启动真实进程。
- 权限测试覆盖拒绝、允许一次、允许当前 Run、超时拒绝和永久策略跳转 Settings；不得
  把 mock 交互声称为真实 PermissionBroker enforcement。
- Handoff 测试分别验证 inspect-only 不产生 Run Command，以及 execute-confirmed 在目标
  与内容预览后只产生一次显式执行 Command。
- 全局 Shell 测试覆盖 Connections、Provider Health、全局设置和显式退出；关闭窗口与
  退出入口必须呈现不同结果。
- 高风险确认测试从 External Task、Settings、Changes 和删除/丢弃入口复用同一确认
  contract，断言动作、目标、影响、不可绕过原因、确认结果与焦点恢复。
- Attention 测试从每个 Project surface 和 Settings 打开抽屉，并验证 deep link、
  resolve 后从待办消失但 Activity 仍有记录。
- Layout 测试同时覆盖鼠标语义和键盘等价命令，验证关闭/移动 Tab 不产生 stop、
  delete、runtime、PTY 或 Git Command。
- 降级测试验证未连接飞书、Git not-ready、Provider unavailable 与 root unavailable
  的不同可见结果，避免把局部能力故障折叠为一个 Project 状态。
- 既有 Vitest reducer 测试提供纯状态测试先例；registry contract tests 提供共享合同
  先例；fake CLI runtime tests 提供通过边界观察事件而不调用真实服务的先例。
- 默认测试不得使用真实 Agent 鉴权、模型额度、飞书租户、网络或本机长期凭据。
- Phase 1 验收至少运行 TypeScript 检查、完整默认测试、生产构建、diff whitespace
  检查和 `npm run test:ui`；真实 CLI/飞书 E2E 与 GUI 人工验收必须单独如实记录。

## 不在范围内

- 真实 Agent 子进程、模型调用、session 恢复和 RunStore。
- 真实 PTY、Terminal 进程和 structured Run/PTY 生命周期接线。
- 真实 git worktree 创建、diff、validation、drift、rebase 或 ff-only merge。
- ProjectStore、schema migration、滚动快照、正式持久化和 v0.1 数据迁移。
- PermissionBroker 的真实强制执行、Provider 原生权限响应和系统 sandbox。
- 飞书登录、BrowserView/WebContentsView、安全 partition、真实页面导航和 Cookie。
- 飞书 CLI/OpenAPI CRUD、Connector 凭据、系统钥匙串、版本冲突写入和外部审计。
- 外部事件订阅、自动触发规则、后台 daemon 和无人确认自治。
- Agent/Project 的真实归档、永久删除、退出 handoff 和 crash recovery。
- 上述生命周期动作的 UI、预览、确认和 mock 结果仍在 Phase 1 范围；这里只排除真实
  进程、持久化、文件或删除副作用。
- 多主窗口、Tab 脱离窗口、镜像 Agent View 和命名布局集合。
- 完整 Candidate 比较、Review/Revision 编排、云同步、多人协作和 marketplace。
- 直接复用或逐行迁移 throwaway prototype。
- 修复当前 v0.1 的 bypass/auto-approve 安全缺口；该工作属于真实执行阶段，且最小
  PermissionBroker 完成前不得启动 v0.2 真实 Run。

## 补充说明

- 设计基线已冻结；[产品身份迁移 #17](https://github.com/pcliangx/agent-squad-hq/issues/17)
  已完成。Phase 1 仍仅在用户显式开工后从
  [GitHub Issue #1](https://github.com/pcliangx/agent-squad-hq/issues/1) 开始；发布本 spec
  或完成改名都不等于自动启动 UI 实现。
- 测试接缝已由用户确认：一个主 `WorkbenchPort` 接缝、一个 split-tree 算法护栏和
  一个 Electron 发布护栏。
- 领域词汇以 [CONTEXT](../../CONTEXT.md) 为准；产品与交互以
  [UX-v0.2](../../docs/UX-v0.2.md) 为准；阶段边界以
  [PLAN-v0.2](../../docs/PLAN-v0.2.md) 为准。
- 工作区、飞书边界、UI-first 交付和强制执行门禁分别受
  [ADR-0009](../../docs/adr/0009-command-center-workspace-lifecycle.md)、
  [ADR-0010](../../docs/adr/0010-feishu-integration-trust-boundaries.md)、
  [ADR-0011](../../docs/adr/0011-ui-first-contract-driven-delivery.md) 和
  [ADR-0012](../../docs/adr/0012-enforced-execution-and-brokered-capabilities.md) 约束；产品
  身份与兼容迁移由
  [ADR-0013](../../docs/adr/0013-agent-squad-hq-product-identity.md) 约束。
- [指挥中心原型说明](../../docs/design/README.md) 只用于设计追溯，不是生产实现来源。
- 实现拆分已经 `to-tickets` 收敛为
  [GitHub Issues #1–#16](https://github.com/pcliangx/agent-squad-hq/issues) 的 16 个纵向
  tracer bullets。前 14 票逐步交付完整功能 UI，#15 建立 Electron 冒烟骨架，#16
  完成可访问性、视觉与发布门禁；范围、labels、comments、状态和原生阻塞关系只以
  GitHub 为 truth。
- 当前没有阻塞 Phase 1 spec 的产品语义问题；#17 已完成，#1 可作为显式开工入口。
  真实 CLI E2E、飞书测试租户 E2E 和 GUI 人工验收不属于本 spec 已完成的验证。
