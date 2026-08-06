import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type {
  AgentInstanceId,
  AgentInstanceViewModel,
  AgentOpenMode,
  AgentRuntimeState,
  AgentWorktreeMode,
  CommandResult,
  LayoutOperation,
  ProjectViewModel,
  WorkbenchViewModel
} from './workbench/contract'
import { id } from './workbench/contract'
import { resolveProviderModelSelection } from './workbench/provider-capability'
import {
  providerCode,
  providerLabel,
  RUNTIME_STATE_LABEL
} from './agent-display'
import { StatusDot, statusDotState } from './status-dot'
import { ProviderIcon } from './provider-icon'
import type { SendCommand } from './agents-surface'

/**
 * The 需要处理 family is exactly the attention StatusDot family (#65):
 * permission-requested / needs-input / failed / cancelled / interrupted.
 * One predicate shared by the group and the footer so the two counts can
 * never drift apart.
 */
const isAttentionAgent = (agent: AgentInstanceViewModel): boolean =>
  statusDotState(agent.runtimeState) === 'attention'

/**
 * The fixed 244px context directory pane of the frozen A command-center
 * shell (#66, UX-v0.2 §4.2): it sits between the icon nav rail and the
 * workspace and is visible on every Project surface. Since #75 project
 * switching lives in the persistent top switch bar — this pane is a pure
 * context display: the Project identity card (name + root path) plus the
 * Agent Directory (the only directory the frozen baseline defines);
 * per-surface directories (任务清单、知识空间…) land with their own
 * surface issues.
 *
 * The pane is the SINGLE Agent Directory — the Agents surface no longer
 * keeps an internal column, so filter logic exists exactly once. All facts
 * come from the WorkbenchPort snapshot; every mutation is a typed command
 * sent through the port.
 */

export function ContextPane({
  project,
  snapshot,
  agents,
  openAttentionTargets,
  sendCommand,
  sendLayout,
  registerAgentButton,
  searchInputRef,
  newAgentButtonRef
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  /** Agents of the active project (pre-filtered by the shell). */
  agents: AgentInstanceViewModel[]
  openAttentionTargets: Set<string>
  sendCommand: SendCommand
  sendLayout: (operation: LayoutOperation) => Promise<CommandResult>
  registerAgentButton: (
    agentInstanceId: AgentInstanceId,
    element: HTMLButtonElement | null
  ) => void
  searchInputRef: RefObject<HTMLInputElement | null>
  newAgentButtonRef: RefObject<HTMLButtonElement | null>
}) {
  const [query, setQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState<'all' | string>('all')
  const [stateFilter, setStateFilter] = useState<'all' | AgentRuntimeState>('all')
  const [sortMode, setSortMode] = useState<SortMode>('recent-activity')
  const [showNewAgent, setShowNewAgent] = useState(false)

  const closeNewAgentDialog = () => {
    setShowNewAgent(false)
    newAgentButtonRef.current?.focus()
  }

  // View state derived from the project layout by AgentInstanceId:
  // which instances are open as tabs, and which one is currently visible.
  const { openTabs, visibleTabs } = useMemo(() => {
    const open = new Set<string>()
    const visible = new Set<string>()
    // In temporary Focus only the panel on screen counts as visible.
    const focusPanelId = project.layout.temporaryFocusPanelId
    for (const [panelId, panel] of Object.entries(project.layout.panels)) {
      for (const tab of panel.tabs) open.add(tab)
      if ((!focusPanelId || panelId === focusPanelId) && panel.activeTabId) {
        visible.add(panel.activeTabId)
      }
    }
    return { openTabs: open, visibleTabs: visible }
  }, [project.layout])

  // The focused panel's visible tab drives the row's selected styling —
  // the same agent the workspace is currently showing.
  const focusedVisibleTabId = project.layout.focusedPanelId
    ? project.layout.panels[project.layout.focusedPanelId]?.activeTabId
    : undefined

  const providerOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const agent of agents) {
      if (!seen.has(agent.providerId)) {
        seen.set(agent.providerId, providerLabel(agent.providerId))
      }
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }))
  }, [agents])

  const stateOptions = useMemo(() => {
    const seen = new Set<AgentRuntimeState>()
    for (const agent of agents) seen.add(agent.runtimeState)
    return [...seen].map((value) => ({
      value,
      label: RUNTIME_STATE_LABEL[value]
    }))
  }, [agents])

  const visibleAgents = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = agents.filter((agent) => {
      // The single search box matches name, Provider and state label, like
      // the frozen prototype (#66).
      if (q) {
        const haystack =
          `${agent.name} ${providerLabel(agent.providerId)} ${RUNTIME_STATE_LABEL[agent.runtimeState]}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      if (providerFilter !== 'all' && agent.providerId !== providerFilter) {
        return false
      }
      if (stateFilter !== 'all' && agent.runtimeState !== stateFilter) {
        return false
      }
      return true
    })
    return filtered.sort((a, b) => {
      if (sortMode === 'name') return a.name.localeCompare(b.name)
      return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    })
  }, [agents, query, providerFilter, stateFilter, sortMode])

  // 需要处理 group (#66): grouped only in the default view; an active
  // search or filter renders one flat result list instead.
  const isFiltering =
    query.trim() !== '' || providerFilter !== 'all' || stateFilter !== 'all'
  const needsAttentionAgents = useMemo(
    () => visibleAgents.filter(isAttentionAgent),
    [visibleAgents]
  )
  // The attention family is pinned under 需要处理 and not repeated below —
  // every instance appears exactly once, so row accessible names stay unique.
  const remainingAgents = useMemo(() => {
    const pinned = new Set(needsAttentionAgents.map((a) => a.agentInstanceId))
    return visibleAgents.filter((agent) => !pinned.has(agent.agentInstanceId))
  }, [visibleAgents, needsAttentionAgents])

  // Footer summary from contract facts only: active Run count comes from the
  // Project ViewModel; the waiting count is the attention family above.
  const attentionTotal = useMemo(
    () => agents.filter(isAttentionAgent).length,
    [agents]
  )

  const openAgent = (agentInstanceId: AgentInstanceViewModel['agentInstanceId']) => {
    const layout = project.layout
    const panelId =
      layout.focusedPanelId ??
      (Object.keys(layout.panels)[0] as string | undefined) ??
      // Empty workspace: the layout owner allocates a fresh panel.
      'panel-fallback'
    void sendLayout({
      kind: 'open-tab',
      panelId: id(panelId, 'PanelId'),
      agentInstanceId
    })
  }

  const openAgentInNewPanel = (
    agentInstanceId: AgentInstanceViewModel['agentInstanceId']
  ) => {
    void sendLayout({
      kind: 'open-tab-in-new-panel',
      agentInstanceId,
      direction: 'horizontal'
    })
  }

  const renderRow = (agent: AgentInstanceViewModel) => {
    const viewBadges: string[] = []
    if (visibleTabs.has(agent.agentInstanceId)) viewBadges.push('当前可见')
    else if (openTabs.has(agent.agentInstanceId)) viewBadges.push('已打开')
    if (agent.terminalState === 'active') viewBadges.push('Terminal 接管')
    const isSelected = focusedVisibleTabId === agent.agentInstanceId
    return (
      <li key={agent.agentInstanceId} className="flex items-stretch gap-0.5">
        <button
          ref={(element) =>
            registerAgentButton(agent.agentInstanceId, element)
          }
          className={`grid min-h-[48px] min-w-0 flex-1 grid-cols-[31px_minmax(0,1fr)_auto] items-center gap-2 rounded-[9px] border px-[7px] py-1.5 text-left transition-colors ${
            isSelected
              ? 'border-brand-border bg-paper shadow-lift'
              : 'border-transparent hover:bg-paper'
          }`}
          onClick={() => openAgent(agent.agentInstanceId)}
        >
          {/* Decorative avatar — the Provider is already named in the
              secondary label, so the button's accessible name still starts
              with the Agent Name. */}
          {/* #79: Provider brand icon — original SVG abstraction. */}
          <ProviderIcon
            providerId={agent.providerId}
            size={31}
            className={isSelected ? 'ring-2 ring-brand' : ''}
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-mono text-[11px] font-semibold text-ink">
                {agent.name}
              </span>
              {openAttentionTargets.has(agent.agentInstanceId) && (
                <span
                  role="img"
                  aria-label="有待处理事项"
                  className="text-amber"
                >
                  ●
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-[10px] text-muted">
              {providerLabel(agent.providerId)} ·{' '}
              {RUNTIME_STATE_LABEL[agent.runtimeState]}
              {viewBadges.length > 0 && ` · ${viewBadges.join(' · ')}`}
            </span>
          </span>
          {/* Adjacent text names the state; the dot stays decorative while
              shape + color double-code it (#65). */}
          <StatusDot state={statusDotState(agent.runtimeState)} />
        </button>
        <button
          aria-label={`在新 Panel 打开 ${agent.name}`}
          className="shrink-0 rounded-lg px-1.5 text-xs text-muted hover:bg-paper hover:text-ink"
          onClick={(e) => {
            e.stopPropagation()
            openAgentInNewPanel(agent.agentInstanceId)
          }}
        >
          ⇱
        </button>
        {agent.runtimeState !== 'archived' && (
          <button
            aria-label={`关闭 ${agent.name}`}
            title="关闭（归档）此 Agent 实例"
            className="shrink-0 rounded-lg px-1.5 text-xs text-muted hover:bg-paper hover:text-danger"
            onClick={(e) => {
              e.stopPropagation()
              void sendCommand({
                kind: 'archive-instance',
                projectId: project.projectId,
                agentInstanceId: agent.agentInstanceId
              })
            }}
          >
            ✕
          </button>
        )}
      </li>
    )
  }

  const groupHeader = (label: string, count: number) => (
    <li
      key={`group-${label}`}
      className="flex items-center justify-between px-2 pb-0.5 pt-1.5"
    >
      <span className="section-label">{label}</span>
      <span className="text-[10px] text-muted">{count}</span>
    </li>
  )

  return (
    <aside
      role="region"
      aria-label="Agent 目录"
      className="flex w-[244px] shrink-0 flex-col border-r border-line bg-raised"
    >
      {/* Project identity card: 36px brand mark, the project name as static
          text and the root path summary. Switching moved to the persistent
          top switch bar in #75 — this card is context display only. */}
      <div className="px-2.5 pt-2.5">
        <div className="flex items-center gap-2 rounded-[10px] border border-line bg-paper px-2 py-1.5">
          <span
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-soft font-mono text-[11px] font-bold text-brand"
          >
            {project.name.slice(0, 1)}
          </span>
          <div className="min-w-0 flex-1">
            <span className="block truncate px-1 text-[12px] font-semibold text-ink">
              {project.name}
            </span>
            <span className="block truncate px-1 text-[10px] text-muted">
              {project.rootPath ?? '—'}
            </span>
          </div>
        </div>
      </div>

      {/* Directory head of the frozen baseline (#66): AGENT DIRECTORY + the
          new-agent action. Dispatch stays in the shell header. */}
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <h2 className="section-label">Agent Directory</h2>
        <button
          ref={newAgentButtonRef}
          className="mini-button mini-button-primary"
          onClick={() => setShowNewAgent(true)}
        >
          新建 Agent
        </button>
      </div>

      <div className="space-y-1.5 px-3 py-2">
        <input
          ref={searchInputRef}
          aria-label="搜索 Agent"
          className="w-full rounded-lg border border-line bg-paper px-2 py-1 text-sm text-ink placeholder:text-muted"
          placeholder="搜索名称、Provider 或状态…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex gap-1.5">
          <select
            aria-label="按 Provider 过滤"
            className="w-full rounded-lg border border-line bg-paper px-1 py-1 text-xs text-ink"
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
          >
            <option value="all">全部 Provider</option>
            {providerOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            aria-label="按状态过滤"
            className="w-full rounded-lg border border-line bg-paper px-1 py-1 text-xs text-ink"
            value={stateFilter}
            onChange={(e) =>
              setStateFilter(e.target.value as AgentRuntimeState | 'all')
            }
          >
            <option value="all">全部状态</option>
            {stateOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <select
          aria-label="排序方式"
          className="w-full rounded-lg border border-line bg-paper px-1 py-1 text-xs text-ink"
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
        >
          <option value="recent-activity">最近活动</option>
          <option value="name">名称</option>
        </select>
      </div>

      <ul
        aria-label="Agent 列表"
        className="min-h-0 flex-1 space-y-0.5 overflow-auto px-2 pb-2"
      >
        {visibleAgents.length === 0 ? (
          <li className="px-1 py-2 text-xs text-muted">没有匹配的 Agent</li>
        ) : isFiltering ? (
          visibleAgents.map(renderRow)
        ) : (
          <>
            {needsAttentionAgents.length > 0 && (
              <>
                {groupHeader('需要处理', needsAttentionAgents.length)}
                {needsAttentionAgents.map(renderRow)}
              </>
            )}
            {groupHeader('全部实例', remainingAgents.length)}
            {remainingAgents.map(renderRow)}
          </>
        )}
      </ul>

      {/* Run summary + root path (#66) — counts come from the contract
          ViewModel and the shared attention family, never hard-coded. */}
      <div className="border-t border-line px-3 py-2 text-[10px] text-muted">
        <span>
          {project.activeRunCount} 个运行中 · {attentionTotal} 个等待确认
        </span>
        <span className="mt-0.5 block truncate">{project.rootPath ?? '—'}</span>
      </div>

      {showNewAgent && (
        <NewAgentDialog
          project={project}
          snapshot={snapshot}
          sendCommand={sendCommand}
          onClose={closeNewAgentDialog}
        />
      )}
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type SortMode = 'recent-activity' | 'name'

const DIALOG_FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), ' +
  'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function isAgentOpenMode(value: unknown): value is AgentOpenMode {
  return (
    value === 'current-panel' ||
    value === 'background' ||
    value === 'new-panel'
  )
}

function isAgentWorktreeMode(value: unknown): value is AgentWorktreeMode {
  return value === 'isolated' || value === 'read-only-shared'
}

function NewAgentDialog({
  project,
  snapshot,
  sendCommand,
  onClose
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  sendCommand: SendCommand
  onClose: () => void
}) {
  const readyProviders = snapshot.global.providers.filter(
    (p) => p.status === 'ready'
  )
  const projectConfiguration = snapshot.appliedConfigurations.find(
    (configuration) =>
      configuration.owner.kind === 'project' &&
      configuration.owner.projectId === project.projectId
  )
  const appliedProviderId = projectConfiguration?.values['defaults.providerId']
  const appliedModelId = projectConfiguration?.values['defaults.model']
  const appliedOpenMode = projectConfiguration?.values['defaults.openMode']
  const appliedWorktreeMode =
    projectConfiguration?.values['defaults.worktreeMode']
  const [name, setName] = useState('')
  const [providerId, setProviderId] = useState<string>(
    typeof appliedProviderId === 'string' ? appliedProviderId : ''
  )
  const [modelId, setModelId] = useState(
    typeof appliedModelId === 'string' ? appliedModelId : ''
  )
  const [open, setOpen] = useState<AgentOpenMode>(
    isAgentOpenMode(appliedOpenMode) ? appliedOpenMode : 'current-panel'
  )
  const [worktreeMode, setWorktreeMode] = useState<AgentWorktreeMode>(
    isAgentWorktreeMode(appliedWorktreeMode)
      ? appliedWorktreeMode
      : 'isolated'
  )
  const [error, setError] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameInputRef.current?.focus()
  }, [])

  const selectedProvider = snapshot.global.providers.find(
    (provider) => provider.providerId === providerId
  )
  const providerSelection = resolveProviderModelSelection(
    snapshot.global.providers,
    id(providerId, 'AgentProviderId'),
    modelId
  )
  const capabilityError = providerSelection.ok
    ? null
    : providerSelection.message
  const providerIsSelectable = readyProviders.some(
    (provider) => provider.providerId === providerId
  )
  const modelIsSelectable = Boolean(
    selectedProvider?.models.some((model) => model.modelId === modelId)
  )

  const selectProvider = (nextProviderId: string) => {
    const nextProvider = readyProviders.find(
      (provider) => provider.providerId === nextProviderId
    )
    setProviderId(nextProviderId)
    setModelId((currentModelId) =>
      nextProvider?.models.some((model) => model.modelId === currentModelId)
        ? currentModelId
        : (nextProvider?.models[0]?.modelId ?? '')
    )
    setError(null)
  }

  const submit = async () => {
    if (!providerSelection.ok) {
      setError(providerSelection.message)
      return
    }
    const result = await sendCommand({
      kind: 'create-agent',
      projectId: project.projectId,
      name,
      providerId: id(providerId, 'AgentProviderId'),
      modelId,
      open,
      worktreeMode
    })
    if (result.ok) {
      onClose()
    } else {
      setError(result.message)
    }
  }

  return (
    <div
      role="dialog"
      aria-label="新建 Agent"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
          return
        }
        if (event.key !== 'Tab') return

        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            DIALOG_FOCUSABLE_SELECTOR
          )
        )
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (!first || !last) return
        const leavesDialog = event.shiftKey
          ? document.activeElement === first
          : document.activeElement === last
        if (leavesDialog) {
          event.preventDefault()
          const next = event.shiftKey ? last : first
          next.focus()
        }
      }}
    >
      <div className="w-80 space-y-3 rounded-[11px] border border-line bg-paper p-4 shadow-overlay">
        <h3 className="text-sm font-medium text-ink">新建 Agent</h3>

        <label className="block text-xs text-muted">
          Agent 名称
          <input
            ref={nameInputRef}
            aria-label="Agent 名称"
            className="mt-1 w-full rounded-lg border border-line bg-paper px-2 py-1 text-sm text-ink"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="block text-xs text-muted">
          Provider
          <select
            aria-label="Provider"
            className="mt-1 w-full rounded-lg border border-line bg-paper px-2 py-1 text-sm text-ink"
            value={providerId}
            onChange={(e) => selectProvider(e.target.value)}
          >
            {!providerIsSelectable && (
              <option value={providerId} disabled>
                {providerId
                  ? `${selectedProvider?.displayName ?? providerId}（不可用）`
                  : '未配置 Provider'}
              </option>
            )}
            {readyProviders.map((p) => (
              <option key={p.providerId} value={p.providerId}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-muted">
          模型
          <select
            aria-label="模型"
            className="mt-1 w-full rounded-lg border border-line bg-paper px-2 py-1 text-sm text-ink"
            value={modelId}
            onChange={(e) => {
              setModelId(e.target.value)
              setError(null)
            }}
          >
            {!modelIsSelectable && (
              <option value={modelId} disabled>
                {modelId ? `${modelId}（不兼容）` : '未配置模型'}
              </option>
            )}
            {selectedProvider?.models.map((model) => (
              <option key={model.modelId} value={model.modelId}>
                {model.displayName}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-muted">
          打开方式
          <select
            aria-label="打开方式"
            className="mt-1 w-full rounded-lg border border-line bg-paper px-2 py-1 text-sm text-ink"
            value={open}
            onChange={(e) => setOpen(e.target.value as AgentOpenMode)}
          >
            <option value="current-panel">当前 Panel</option>
            <option value="new-panel">新 Panel</option>
            <option value="background">后台打开</option>
          </select>
        </label>

        <label className="block text-xs text-muted">
          worktree 模式
          <select
            aria-label="worktree 模式"
            className="mt-1 w-full rounded-lg border border-line bg-paper px-2 py-1 text-sm text-ink"
            value={worktreeMode}
            onChange={(e) =>
              setWorktreeMode(e.target.value as AgentWorktreeMode)
            }
          >
            <option value="isolated">独立 worktree</option>
            <option value="read-only-shared">共享只读</option>
          </select>
        </label>

        {(error ?? capabilityError) && (
          <p role="alert" className="text-xs text-danger">
            {error ?? capabilityError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            className="btn btn-ghost min-h-[29px]"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="mini-button mini-button-primary"
            disabled={!providerSelection.ok}
            onClick={() => void submit()}
          >
            创建 Agent
          </button>
        </div>
      </div>
    </div>
  )
}
