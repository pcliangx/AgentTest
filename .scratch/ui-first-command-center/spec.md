# UI-first Command Center

Status: accepted

## 目标

在不接入真实 Agent、PTY、Git mutation、ProjectStore 迁移或飞书副作用的前提下，
使用正式 React/TypeScript renderer 实现已冻结的 Project-first 指挥中心 UI，
并由契约化 `MockScenarioAdapter` 驱动全部关键状态。

## 冻结的视觉结构

- 指挥中心：A 双侧栏为常态骨架；B 运行雷达作为可展开全局态势抽屉；
  C Agent Directory 只在 Focus/窄窗口作为 palette。
- Project Settings：A 层级配置台为唯一完整编辑器；B 为实例策略比较视图；
  C 为下一次 Run readiness 摘要。
- 1280×800 是最低桌面基线；1–3 Panel 为默认密度，4+ 不阻断并显式滚动/溢出。

## 最小契约

```ts
type ProjectId = string & { readonly __brand: 'ProjectId' }
type AgentProviderId = string & { readonly __brand: 'AgentProviderId' }
type AgentInstanceId = string & { readonly __brand: 'AgentInstanceId' }
type RunId = string & { readonly __brand: 'RunId' }
type DispatchId = string & { readonly __brand: 'DispatchId' }
type HandoffId = string & { readonly __brand: 'HandoffId' }
type ConnectionId = string & { readonly __brand: 'ConnectionId' }
type PanelId = string & { readonly __brand: 'PanelId' }
type SplitNodeId = string & { readonly __brand: 'SplitNodeId' }

type ProjectLifecycle = 'active' | 'archived'
type RootAvailability = 'available' | 'unavailable'
type RepositoryReadiness = 'ready' | 'not-ready'
type AgentRuntimeState =
  | 'ready' | 'queued' | 'starting' | 'running' | 'finishing'
  | 'needs-input' | 'permission-requested'
  | 'failed' | 'cancelled' | 'interrupted' | 'unavailable' | 'archived'

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

interface ProjectViewModel {
  projectId: ProjectId
  name: string
  lifecycle: ProjectLifecycle
  rootAvailability: RootAvailability
  repositoryReadiness: RepositoryReadiness
  activity: 'idle' | 'active'
  attentionCount: number
  primaryConnectionId?: ConnectionId
}

interface AgentInstanceViewModel {
  agentInstanceId: AgentInstanceId
  projectId: ProjectId
  name: string
  providerId: AgentProviderId
  runtimeState: AgentRuntimeState
  activeRunId?: RunId
  queueDepth: number
  doctor: 'ready' | 'blocked'
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

interface ConfigurationDraftViewModel {
  owner: { kind: 'project'; projectId: ProjectId }
    | { kind: 'agent'; agentInstanceId: AgentInstanceId }
  appliedVersion: number
  changes: Array<{ fieldPath: string; applied: unknown; draft: unknown }>
}
```

`ViewModel` 只表达已经 main/domain 判定的事实。UI 通过版本化 `Command` 表达用户
意图，包括：打开/激活/关闭/移动 Tab，split/resize/prune/focus Panel，打开 Attention，
暂存/应用/放弃配置，打开 Agent Picker 以及确认 Dispatch。

`Event` 至少覆盖：ViewModel 更新、Run 状态、permission request、Attention 变化、
配置应用结果、冲突/offline/unavailable 和命令拒绝。所有 runtime event 必须携带
`projectId + agentInstanceId + runId`。

## 必须保持的边界

- Agent Tab composer 已明确唯一目标；其他入口必须使用 Picker/chips/`@@`。
- 一个 Agent Instance 最多一个 active structured Run；新工作进入该实例队列。
- Project lifecycle、root availability、Git readiness、activity 与 attention 分离。
- Project 飞书主连接是 `0..1`；没有连接不使 Project 不可用。
- 浏览器身份、Connector 身份、Project scope 和 Run instruction 分离。
- UI 只显示可强制的 effective permission，不把 bypass/worktree 冒充 sandbox。
- `MockScenarioAdapter` 不持久 truth、不执行 Git/进程/凭据/飞书，不复制第二套业务规则。

## 验收

- 固定 Project 一级工作面可达，Global Attention 跨 surface/Settings 可达。
- 至少 8 个 Agent；1280×800 可同时观察 3 Panel，第 4 个 Panel 不阻断。
- Panel 内多 Tab 可鼠标/键盘切换，Tab 可跨 Panel 移动，divider 可鼠标/键盘调整。
- Attention、Agent Picker、Dispatch 预览、队列和显式确认可通过 mock 完整演示。
- Settings 的 draft/applied 按 owner ID 隔离；Discard 回滚，Apply 才更新 applied 版本。
- empty/loading/offline/conflict/unavailable/archived/permission/interrupted 均有可操作状态。
- 组件、交互、键盘、a11y 和 1280×800 视觉回归通过。

## 不在本阶段

真实 Agent/PTY/worktree、ProjectStore 数据迁移、PermissionBroker 执行、飞书登录/CRUD、
任何真实外部副作用，以及直接复制 `docs/design/` HTML。

## 参考

- `docs/UX-v0.2.md`
- `docs/PLAN-v0.2.md`
- `docs/adr/0009-command-center-workspace-lifecycle.md`
- `docs/adr/0011-ui-first-contract-driven-delivery.md`
- `docs/adr/0012-enforced-execution-and-brokered-capabilities.md`
- `docs/design/README.md`
