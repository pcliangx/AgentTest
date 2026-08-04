import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import type {
  AgentInstanceId,
  AgentInstanceViewModel,
  AgentOpenMode,
  AgentRuntimeState,
  AgentWorktreeMode,
  CommandResult,
  LayoutOperation,
  ProjectViewModel,
  WorkbenchCommandBody,
  WorkbenchPort,
  WorkbenchViewModel
} from './workbench/contract'
import { id } from './workbench/contract'
import { resolveProviderModelSelection } from './workbench/provider-capability'
import { providerLabel, RUNTIME_STATE_LABEL } from './agent-display'
import { StatusDot, statusDotState } from './status-dot'
import { WorkspaceArea } from './workspace-layout'

/**
 * Agents surface — Agent Directory, the split-tree workspace with unique
 * Agent Tabs (see `workspace-layout.tsx`), and the New Agent dialog.
 *
 * All facts come from the WorkbenchPort snapshot; every mutation is a
 * typed command sent through the port. The renderer never keys interactions
 * by provider id, array index or panel id — only AgentInstanceId.
 */

export type SendCommand = (
  body: WorkbenchCommandBody,
  expectedRevision?: number
) => Promise<CommandResult>

export type PlanDispatch = WorkbenchPort['planDispatch']

// ---------------------------------------------------------------------------
// Agents surface
// ---------------------------------------------------------------------------

export function AgentsSurface({
  project,
  snapshot,
  planDispatch,
  sendCommand,
  onDispatch
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  planDispatch: PlanDispatch
  sendCommand: SendCommand
  /** Open the shell-level unified Dispatch Picker. */
  onDispatch?: () => void
}) {
  const projectAgents = snapshot.agents.filter(
    (a) => a.projectId === project.projectId
  )
  const openAttentionTargets = useMemo(() => {
    const set = new Set<string>()
    for (const item of snapshot.attentionItems) {
      if (item.state === 'open' && item.target.kind === 'agent') {
        set.add(item.target.agentInstanceId)
      }
    }
    return set
  }, [snapshot.attentionItems])
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null)

  // Focus may prune the final Panel while the Directory stays mounted.
  // Bridge the sibling surfaces through raw-ID refs so focus restoration
  // never needs a selector or an assumption about ID encoding.
  const directoryAgentButtons = useRef(
    new Map<AgentInstanceId, HTMLButtonElement>()
  )
  const directorySearchInput = useRef<HTMLInputElement>(null)
  const directoryNewAgentButton = useRef<HTMLButtonElement>(null)

  const registerDirectoryAgentButton = useCallback(
    (agentInstanceId: AgentInstanceId, element: HTMLButtonElement | null) => {
      if (element) directoryAgentButtons.current.set(agentInstanceId, element)
      else directoryAgentButtons.current.delete(agentInstanceId)
    },
    []
  )
  const focusDirectoryTarget = useCallback(
    (agentInstanceId?: AgentInstanceId) => {
      const target =
        (agentInstanceId
          ? directoryAgentButtons.current.get(agentInstanceId)
          : undefined) ??
        directorySearchInput.current ??
        directoryNewAgentButton.current
      target?.focus()
    },
    []
  )

  /**
   * The surface's single layout-command path: every layout mutation — from
   * the directory or from the workspace — goes through here, so a
   * rejection always restores the authoritative layout and surfaces a
   * recoverable notice (Issue #4 AC4) instead of being dropped silently.
   *
   * Commands bind to the revision of the render the user acted on:
   * discrete actions use that render's revision by default, while
   * multi-event gestures (divider drags, tab drops, dialog confirmations)
   * pass the baseline they captured when the gesture started. A command
   * issued from a stale render stale-rejects instead of silently
   * overwriting a newer authoritative layout.
   */
  const sendLayout = async (
    operation: LayoutOperation,
    expectedRevision?: number
  ): Promise<CommandResult> => {
    const result = await sendCommand(
      {
        kind: 'change-layout',
        projectId: project.projectId,
        operation
      },
      expectedRevision ?? snapshot.revision
    )
    if (!result.ok) {
      setLayoutNotice(`布局操作被拒绝（${result.message}），已恢复最新布局。`)
    }
    return result
  }

  return (
    <section
      role="region"
      aria-label="Agent 工作区"
      className="relative flex h-full min-h-0"
      onKeyDown={(e) => {
        // Escape is the keyboard exit from temporary Focus — normalised to
        // the same focus-panel command as the 退出 Focus button. It lives
        // on the surface (not the workspace container) because the Agent
        // Directory is a sibling of the workspace: Escape must work even
        // when focus is inside the directory (#24 round-3 review).
        if (e.key === 'Escape' && project.layout.temporaryFocusPanelId) {
          e.preventDefault()
          void sendLayout({ kind: 'focus-panel' })
        }
      }}
    >
      <AgentDirectory
        project={project}
        agents={projectAgents}
        snapshot={snapshot}
        openAttentionTargets={openAttentionTargets}
        sendCommand={sendCommand}
        sendLayout={sendLayout}
        onDispatch={onDispatch ?? (() => {})}
        registerAgentButton={registerDirectoryAgentButton}
        searchInputRef={directorySearchInput}
        newAgentButtonRef={directoryNewAgentButton}
      />
      <WorkspaceArea
        project={project}
        snapshot={snapshot}
        openAttentionTargets={openAttentionTargets}
        planDispatch={planDispatch}
        sendLayout={sendLayout}
        sendCommand={sendCommand}
        onFocusExitFallback={focusDirectoryTarget}
      />
      {layoutNotice && (
        <div
          role="status"
          className="absolute right-2 top-2 z-20 flex items-center gap-2 rounded-lg border border-amber bg-amber-soft px-3 py-1.5 text-xs text-amber"
        >
          <span>{layoutNotice}</span>
          <button
            aria-label="关闭提示"
            className="rounded px-1 text-amber hover:bg-amber-soft"
            onClick={() => setLayoutNotice(null)}
          >
            ×
          </button>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Agent Directory
// ---------------------------------------------------------------------------

type SortMode = 'recent-activity' | 'name'

const DIALOG_FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), ' +
  'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function AgentDirectory({
  project,
  agents,
  snapshot,
  openAttentionTargets,
  sendCommand,
  sendLayout,
  onDispatch,
  registerAgentButton,
  searchInputRef,
  newAgentButtonRef
}: {
  project: ProjectViewModel
  agents: AgentInstanceViewModel[]
  snapshot: WorkbenchViewModel
  openAttentionTargets: Set<string>
  sendCommand: SendCommand
  sendLayout: (operation: LayoutOperation) => Promise<CommandResult>
  onDispatch: () => void
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
      if (q && !agent.name.toLowerCase().includes(q)) return false
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

  return (
    <aside
      role="region"
      aria-label="Agent 目录"
      className="flex w-64 shrink-0 flex-col border-r border-line bg-raised"
    >
      <div className="flex items-center justify-between px-3 pt-3">
        <h2 className="text-sm font-medium text-ink">
          Agent 目录
          <span className="ml-1 text-xs text-muted">{agents.length}</span>
        </h2>
        <div className="flex gap-1">
          <button className="mini-button" onClick={onDispatch}>
            派发给 Agent
          </button>
          <button
            ref={newAgentButtonRef}
            className="mini-button mini-button-primary"
            onClick={() => setShowNewAgent(true)}
          >
            新建 Agent
          </button>
        </div>
      </div>

      <div className="space-y-1.5 px-3 py-2">
        <input
          ref={searchInputRef}
          aria-label="搜索 Agent"
          className="w-full rounded-lg border border-line bg-paper px-2 py-1 text-sm text-ink placeholder:text-muted"
          placeholder="按名称搜索…"
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
        {visibleAgents.length === 0 && (
          <li className="px-1 py-2 text-xs text-muted">没有匹配的 Agent</li>
        )}
        {visibleAgents.map((agent) => {
          const viewBadges: string[] = []
          if (visibleTabs.has(agent.agentInstanceId)) viewBadges.push('当前可见')
          else if (openTabs.has(agent.agentInstanceId)) viewBadges.push('已打开')
          if (agent.terminalState === 'active') viewBadges.push('Terminal 接管')
          return (
            <li key={agent.agentInstanceId} className="flex items-stretch">
              <button
                ref={(element) =>
                  registerAgentButton(agent.agentInstanceId, element)
                }
                className="block min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left hover:bg-paper"
                onClick={() => openAgent(agent.agentInstanceId)}
              >
                <span className="flex items-center gap-1.5">
                  {/* Adjacent text names the state; the dot stays decorative
                      while shape + color double-code it (#65). */}
                  <StatusDot state={statusDotState(agent.runtimeState)} />
                  <span className="text-sm font-medium text-ink">
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
                <span className="mt-0.5 block text-xs text-muted">
                  {providerLabel(agent.providerId)} ·{' '}
                  {RUNTIME_STATE_LABEL[agent.runtimeState]}
                  {viewBadges.length > 0 && ` · ${viewBadges.join(' · ')}`}
                </span>
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
            </li>
          )
        })}
      </ul>

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
// New Agent dialog
// ---------------------------------------------------------------------------

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
      className="absolute inset-0 z-10 flex items-center justify-center bg-backdrop"
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
