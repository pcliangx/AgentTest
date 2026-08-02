import { useMemo, useState } from 'react'
import type {
  AgentInstanceViewModel,
  AgentProviderId,
  AgentRuntimeState,
  CommandResult,
  PanelId,
  ProjectViewModel,
  WorkbenchCommandBody,
  WorkbenchViewModel
} from './workbench/contract'
import { id } from './workbench/contract'

/**
 * Agents surface — Agent Directory, single-panel workspace with unique
 * Agent Tabs, and the Agent View with its four secondary entries.
 *
 * All facts come from the WorkbenchPort snapshot; every mutation is a
 * typed command sent through the port. The renderer never keys interactions
 * by provider id, array index or panel id — only AgentInstanceId.
 */

export type SendCommand = (body: WorkbenchCommandBody) => Promise<CommandResult>

// ---------------------------------------------------------------------------
// Display metadata (labels only — never business branching)
// ---------------------------------------------------------------------------

const PROVIDER_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'kimi-code': 'Kimi Code',
  'gemini-cli': 'Gemini CLI'
}

function providerLabel(providerId: AgentProviderId): string {
  return PROVIDER_LABEL[providerId] ?? providerId
}

const RUNTIME_STATE_LABEL: Record<AgentRuntimeState, string> = {
  ready: '就绪',
  queued: '排队中',
  starting: '启动中',
  running: '运行中',
  finishing: '收尾中',
  'needs-input': '需要输入',
  'permission-requested': '等待权限',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  unavailable: '不可用',
  archived: '已归档'
}

const TERMINAL_STATE_LABEL: Record<AgentInstanceViewModel['terminalState'], string> = {
  closed: 'Terminal 未接管',
  opening: 'Terminal 正在打开',
  active: 'Terminal 接管中',
  failed: 'Terminal 打开失败'
}

type AgentSubView = 'chat' | 'activity' | 'changes' | 'terminal'

const SUB_VIEWS: Array<{ view: AgentSubView; label: string }> = [
  { view: 'chat', label: '对话' },
  { view: 'activity', label: '活动' },
  { view: 'changes', label: '改动' },
  { view: 'terminal', label: 'Terminal' }
]

// ---------------------------------------------------------------------------
// Agents surface
// ---------------------------------------------------------------------------

export function AgentsSurface({
  project,
  snapshot,
  sendCommand
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  sendCommand: SendCommand
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

  const [showPicker, setShowPicker] = useState(false)

  return (
    <section
      role="region"
      aria-label="Agent 工作区"
      className="flex h-full min-h-0"
    >
      <AgentDirectory
        project={project}
        agents={projectAgents}
        snapshot={snapshot}
        openAttentionTargets={openAttentionTargets}
        sendCommand={sendCommand}
        onDispatch={() => setShowPicker(true)}
      />
      <WorkspaceArea
        project={project}
        snapshot={snapshot}
        openAttentionTargets={openAttentionTargets}
        sendCommand={sendCommand}
      />
      {showPicker && (
        <DispatchPicker
          project={project}
          agents={projectAgents}
          sendCommand={sendCommand}
          onClose={() => setShowPicker(false)}
        />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Agent Directory
// ---------------------------------------------------------------------------

type SortMode = 'recent-activity' | 'name'

function AgentDirectory({
  project,
  agents,
  snapshot,
  openAttentionTargets,
  sendCommand,
  onDispatch
}: {
  project: ProjectViewModel
  agents: AgentInstanceViewModel[]
  snapshot: WorkbenchViewModel
  openAttentionTargets: Set<string>
  sendCommand: SendCommand
  onDispatch: () => void
}) {
  const [query, setQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState<'all' | string>('all')
  const [stateFilter, setStateFilter] = useState<'all' | AgentRuntimeState>('all')
  const [sortMode, setSortMode] = useState<SortMode>('recent-activity')
  const [showNewAgent, setShowNewAgent] = useState(false)

  // View state derived from the project layout by AgentInstanceId:
  // which instances are open as tabs, and which one is currently visible.
  const { openTabs, visibleTabs } = useMemo(() => {
    const open = new Set<string>()
    const visible = new Set<string>()
    for (const panel of Object.values(project.layout.panels)) {
      for (const tab of panel.tabs) open.add(tab)
      if (panel.activeTabId) visible.add(panel.activeTabId)
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
    void sendCommand({
      kind: 'change-layout',
      projectId: project.projectId,
      operation: {
        kind: 'open-tab',
        panelId: id(panelId, 'PanelId'),
        agentInstanceId
      }
    })
  }

  return (
    <aside
      role="region"
      aria-label="Agent 目录"
      className="flex w-64 shrink-0 flex-col border-r border-neutral-800"
    >
      <div className="flex items-center justify-between px-3 pt-3">
        <h2 className="text-sm font-medium text-neutral-200">
          Agent 目录
          <span className="ml-1 text-xs text-neutral-500">{agents.length}</span>
        </h2>
        <div className="flex gap-1">
          <button
            className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
            onClick={onDispatch}
          >
            派发给 Agent
          </button>
          <button
            className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
            onClick={() => setShowNewAgent(true)}
          >
            新建 Agent
          </button>
        </div>
      </div>

      <div className="space-y-1.5 px-3 py-2">
        <input
          aria-label="搜索 Agent"
          className="w-full rounded bg-neutral-900 px-2 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600"
          placeholder="按名称搜索…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex gap-1.5">
          <select
            aria-label="按 Provider 过滤"
            className="w-full rounded bg-neutral-900 px-1 py-1 text-xs text-neutral-300 outline-none"
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
            className="w-full rounded bg-neutral-900 px-1 py-1 text-xs text-neutral-300 outline-none"
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
          className="w-full rounded bg-neutral-900 px-1 py-1 text-xs text-neutral-300 outline-none"
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
          <li className="px-1 py-2 text-xs text-neutral-600">没有匹配的 Agent</li>
        )}
        {visibleAgents.map((agent) => {
          const viewBadges: string[] = []
          if (visibleTabs.has(agent.agentInstanceId)) viewBadges.push('当前可见')
          else if (openTabs.has(agent.agentInstanceId)) viewBadges.push('已打开')
          if (agent.terminalState === 'active') viewBadges.push('Terminal 接管')
          return (
            <li key={agent.agentInstanceId}>
              <button
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-neutral-900"
                onClick={() => openAgent(agent.agentInstanceId)}
              >
                <span className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-neutral-100">
                    {agent.name}
                  </span>
                  {openAttentionTargets.has(agent.agentInstanceId) && (
                    <span
                      role="img"
                      aria-label="有待处理事项"
                      className="text-amber-400"
                    >
                      ●
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-neutral-500">
                  {providerLabel(agent.providerId)} ·{' '}
                  {RUNTIME_STATE_LABEL[agent.runtimeState]}
                  {viewBadges.length > 0 && ` · ${viewBadges.join(' · ')}`}
                </span>
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
          onClose={() => setShowNewAgent(false)}
        />
      )}
    </aside>
  )
}

// ---------------------------------------------------------------------------
// New Agent dialog
// ---------------------------------------------------------------------------

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
  const [name, setName] = useState('')
  const [providerId, setProviderId] = useState<string>(
    readyProviders[0]?.providerId ?? ''
  )
  const [open, setOpen] = useState<'current-panel' | 'background'>(
    'current-panel'
  )
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const result = await sendCommand({
      kind: 'create-agent',
      projectId: project.projectId,
      name,
      providerId: id(providerId, 'AgentProviderId'),
      open
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
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/60"
    >
      <div className="w-80 space-y-3 rounded-lg border border-neutral-700 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-100">新建 Agent</h3>

        <label className="block text-xs text-neutral-400">
          Agent 名称
          <input
            aria-label="Agent 名称"
            className="mt-1 w-full rounded bg-neutral-950 px-2 py-1 text-sm text-neutral-200 outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="block text-xs text-neutral-400">
          Provider
          <select
            aria-label="Provider"
            className="mt-1 w-full rounded bg-neutral-950 px-2 py-1 text-sm text-neutral-200 outline-none"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
          >
            {readyProviders.map((p) => (
              <option key={p.providerId} value={p.providerId}>
                {providerLabel(p.providerId)}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-neutral-400">
          打开方式
          <select
            aria-label="打开方式"
            className="mt-1 w-full rounded bg-neutral-950 px-2 py-1 text-sm text-neutral-200 outline-none"
            value={open}
            onChange={(e) =>
              setOpen(e.target.value as 'current-panel' | 'background')
            }
          >
            <option value="current-panel">当前 Panel</option>
            <option value="background">后台打开</option>
          </select>
        </label>

        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="rounded bg-neutral-700 px-2 py-1 text-xs text-neutral-100 hover:bg-neutral-600"
            onClick={() => void submit()}
          >
            创建 Agent
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Workspace — panels and unique Agent Tabs
// ---------------------------------------------------------------------------

function WorkspaceArea({
  project,
  snapshot,
  openAttentionTargets,
  sendCommand
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  openAttentionTargets: Set<string>
  sendCommand: SendCommand
}) {
  const layout = project.layout
  const panelEntries = Object.entries(layout.panels)

  if (!layout.root || panelEntries.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-neutral-500">
          尚未打开任何 Agent，请从左侧目录选择。
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      {panelEntries.map(([panelId, panel]) => (
        <PanelView
          key={panelId}
          project={project}
          panelId={id(panelId, 'PanelId')}
          tabs={panel.tabs}
          activeTabId={panel.activeTabId}
          snapshot={snapshot}
          openAttentionTargets={openAttentionTargets}
          sendCommand={sendCommand}
        />
      ))}
    </div>
  )
}

function PanelView({
  project,
  panelId,
  tabs,
  activeTabId,
  snapshot,
  openAttentionTargets,
  sendCommand
}: {
  project: ProjectViewModel
  panelId: PanelId
  tabs: AgentInstanceViewModel['agentInstanceId'][]
  activeTabId?: AgentInstanceViewModel['agentInstanceId']
  snapshot: WorkbenchViewModel
  openAttentionTargets: Set<string>
  sendCommand: SendCommand
}) {
  const activeAgent = snapshot.agents.find(
    (a) => a.agentInstanceId === activeTabId
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="Agent 标签"
        className="flex shrink-0 overflow-x-auto border-b border-neutral-800"
      >
        {tabs.map((tabId) => {
          const agent = snapshot.agents.find(
            (a) => a.agentInstanceId === tabId
          )
          if (!agent) return null
          const selected = tabId === activeTabId
          return (
            <div
              key={tabId}
              role="tab"
              aria-selected={selected}
              tabIndex={0}
              className={`flex cursor-pointer items-center gap-1.5 border-r border-neutral-800 px-3 py-1.5 text-sm ${
                selected
                  ? 'bg-neutral-900 text-neutral-100'
                  : 'text-neutral-500 hover:bg-neutral-900/60'
              }`}
              onClick={() =>
                void sendCommand({
                  kind: 'change-layout',
                  projectId: project.projectId,
                  operation: { kind: 'activate-tab', panelId, agentInstanceId: tabId }
                })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void sendCommand({
                    kind: 'change-layout',
                    projectId: project.projectId,
                    operation: {
                      kind: 'activate-tab',
                      panelId,
                      agentInstanceId: tabId
                    }
                  })
                }
              }}
            >
              <span>{agent.name}</span>
              {openAttentionTargets.has(tabId) && (
                <span role="img" aria-label="有待处理事项" className="text-amber-400">
                  ●
                </span>
              )}
              <span className="text-xs text-neutral-600">
                {providerLabel(agent.providerId)} ·{' '}
                {RUNTIME_STATE_LABEL[agent.runtimeState]}
              </span>
              <button
                aria-label={`关闭标签 ${agent.name}`}
                className="ml-1 rounded px-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                onClick={(e) => {
                  e.stopPropagation()
                  void sendCommand({
                    kind: 'change-layout',
                    projectId: project.projectId,
                    operation: {
                      kind: 'close-tab',
                      panelId,
                      agentInstanceId: tabId
                    }
                  })
                }}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>

      {activeAgent ? (
        <AgentView
          key={activeAgent.agentInstanceId}
          project={project}
          agent={activeAgent}
          snapshot={snapshot}
          sendCommand={sendCommand}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-neutral-500">未选择 Agent</p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agent View — four stable secondary entries
// ---------------------------------------------------------------------------

function AgentView({
  project,
  agent,
  snapshot,
  sendCommand
}: {
  project: ProjectViewModel
  agent: AgentInstanceViewModel
  snapshot: WorkbenchViewModel
  sendCommand: SendCommand
}) {
  const [subView, setSubView] = useState<AgentSubView>('chat')

  const agentActivity = snapshot.activity
    .filter((a) => a.agentInstanceId === agent.agentInstanceId)
    .sort((a, b) => b.timestamp - a.timestamp)

  return (
    <section
      role="region"
      aria-label="Agent 视图"
      className="flex min-h-0 flex-1 flex-col p-4"
    >
      <header className="mb-3">
        <h3 className="text-base font-medium text-neutral-100">{agent.name}</h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          {providerLabel(agent.providerId)} ·{' '}
          {RUNTIME_STATE_LABEL[agent.runtimeState]}
        </p>
      </header>

      <div className="mb-3 flex gap-1 border-b border-neutral-800">
        {SUB_VIEWS.map(({ view, label }) => (
          <button
            key={view}
            className={`px-2 py-1 text-sm ${
              subView === view
                ? 'border-b-2 border-neutral-300 text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
            onClick={() => setSubView(view)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto text-sm text-neutral-400">
        {subView === 'chat' && (
          <ChatState
            project={project}
            agent={agent}
            sendCommand={sendCommand}
          />
        )}
        {subView === 'activity' &&
          (agentActivity.length === 0 ? (
            <p className="text-neutral-500">暂无活动记录</p>
          ) : (
            <ul className="space-y-1.5">
              {agentActivity.map((entry) => (
                <li key={entry.activityId} className="text-neutral-300">
                  {entry.summary}
                </li>
              ))}
            </ul>
          ))}
        {subView === 'changes' && (
          <p className="text-neutral-500">暂无改动</p>
        )}
        {subView === 'terminal' && (
          <p className="text-neutral-500">
            {TERMINAL_STATE_LABEL[agent.terminalState]}
          </p>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Chat sub-view — state text driven only by port-judged facts (#20)
// ---------------------------------------------------------------------------

const ACTIVE_RUN_STATES: ReadonlySet<AgentRuntimeState> = new Set([
  'starting',
  'running',
  'finishing',
  'needs-input',
  'permission-requested'
])

function ChatState({
  project,
  agent,
  sendCommand
}: {
  project: ProjectViewModel
  agent: AgentInstanceViewModel
  sendCommand: SendCommand
}) {
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const disabled =
    agent.runtimeState === 'unavailable' || agent.runtimeState === 'archived'
  const busy = ACTIVE_RUN_STATES.has(agent.runtimeState) || !!agent.activeRunId

  const submit = async () => {
    const instruction = draft.trim()
    if (!instruction || disabled) return
    setNotice(null)
    const result = await sendCommand({
      kind: 'send-agent-instruction',
      projectId: project.projectId,
      agentInstanceId: agent.agentInstanceId,
      instruction,
      // When a Run is active, the instruction joins that Run rather than
      // starting a second concurrent one; otherwise it starts/queues the
      // instance's next Run. The composer never addresses another instance.
      mode: busy ? 'reply-current-run' : 'start-or-queue'
    })
    if (result.ok) {
      setDraft('')
    } else {
      setNotice(result.message)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="log"
        aria-label="对话记录"
        className="min-h-0 flex-1 overflow-auto"
      >
        {agent.runtimeState === 'unavailable' ? (
          <p className="text-neutral-500">
            Provider 不可用；当前仅可查看历史记录，修复 Provider 后可恢复。
          </p>
        ) : busy ? (
          <p className="text-neutral-500">
            当前有进行中的 Run；结构化对话内容将在真实执行通道接入后展示。
          </p>
        ) : (
          <p className="text-neutral-500">
            暂无对话记录；发送首条消息后才会启动 Run。
          </p>
        )}
        {/* Assistant sample text containing @@ — rendered as plain text only.
            It must never trigger a dispatch. */}
        <p className="mt-2 text-neutral-600">
          示例 assistant 输出：已通知 @@cc_sql 复核异常处理策略。
        </p>
      </div>

      {notice && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {notice}
        </p>
      )}

      <div className="mt-2 flex gap-2 border-t border-neutral-800 pt-2">
        <textarea
          aria-label="发送给当前 Agent"
          placeholder="发送给当前 Agent…"
          className="min-h-[2.5rem] flex-1 resize-none rounded bg-neutral-900 px-2 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="shrink-0 rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
          disabled={disabled || draft.trim().length === 0}
          onClick={() => void submit()}
        >
          发送给当前 Agent
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dispatch Picker — multi-target selection, @@ parsing, preview & confirm (#6)
// ---------------------------------------------------------------------------

const AT_AT_ALL = /(?:^|\s)@@all\b/
const AT_AT_NAME = /(?:^|\s)@@([A-Za-z0-9_\-]+)/g

/** Resolves @@ tokens against the project's agents, returning the unique set
 *  of resolved AgentInstanceIds plus any unresolved names for surfacing.
 *  `@@all` expands to every instance in scope; individual `@@<name>` resolve
 *  case-insensitively by Agent Name. Anything else stays plain text. */
function resolveAtAt(
  text: string,
  agents: AgentInstanceViewModel[]
): {
  ids: Set<AgentInstanceViewModel['agentInstanceId']>
  unresolved: string[]
  hasAll: boolean
} {
  const ids = new Set<AgentInstanceViewModel['agentInstanceId']>()
  const unresolved: string[] = []
  const byName = new Map<string, AgentInstanceViewModel>()
  for (const a of agents) byName.set(a.name.toLowerCase(), a)

  // `@@all` is checked without the global flag, so lastIndex cannot leak.
  const hasAll = AT_AT_ALL.test(text)
  if (hasAll) {
    for (const a of agents) ids.add(a.agentInstanceId)
  } else {
    const names = new Set<string>()
    let m: RegExpExecArray | null
    AT_AT_NAME.lastIndex = 0
    while ((m = AT_AT_NAME.exec(text)) !== null) names.add(m[1])
    for (const n of names) {
      const a = byName.get(n.toLowerCase())
      if (a) ids.add(a.agentInstanceId)
      else unresolved.push(n)
    }
  }
  return { ids, unresolved, hasAll }
}

function DispatchPicker({
  project,
  agents,
  sendCommand,
  onClose
}: {
  project: ProjectViewModel
  agents: AgentInstanceViewModel[]
  sendCommand: SendCommand
  onClose: () => void
}) {
  const [instruction, setInstruction] = useState('')
  const [manual, setManual] = useState<
    Set<AgentInstanceViewModel['agentInstanceId']>
  >(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const [awaitingBroadcast, setAwaitingBroadcast] = useState(false)

  // @@ references resolved live from the instruction text.
  const resolved = resolveAtAt(instruction, agents)

  // Effective target set = manually picked chips ∪ @@-resolved chips.
  const targetIds = new Set([...manual, ...resolved.ids])
  const targets = agents.filter((a) => targetIds.has(a.agentInstanceId))

  const toggleManual = (agentInstanceId: AgentInstanceViewModel['agentInstanceId']) => {
    setManual((prev) => {
      const next = new Set(prev)
      if (next.has(agentInstanceId)) next.delete(agentInstanceId)
      else next.add(agentInstanceId)
      return next
    })
  }

  const queuePosition = project.queuedRunCount + 1

  const confirm = async () => {
    if (targets.length === 0 || instruction.trim().length === 0) return
    setNotice(null)
    // @@all is a broadcast — it must be explicitly confirmed a second time
    // before any confirm-dispatch command leaves the renderer.
    if (resolved.hasAll && !awaitingBroadcast) {
      setAwaitingBroadcast(true)
      return
    }
    const result = await sendCommand({
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: targets.map((a) => a.agentInstanceId),
      instruction: instruction.trim()
    })
    if (result.ok) {
      onClose()
    } else {
      setAwaitingBroadcast(false)
      setNotice(result.message)
    }
  }

  return (
    <div
      role="dialog"
      aria-label="派发给 Agent"
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/60"
    >
      <div className="flex max-h-[80%] w-[40rem] flex-col space-y-3 overflow-auto rounded-lg border border-neutral-700 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-100">派发给 Agent</h3>

        <div className="space-y-1">
          <div className="text-xs text-neutral-400">
            选择目标（当前项目：{project.name}）
          </div>
          <ul
            aria-label="可选 Agent"
            className="max-h-40 space-y-0.5 overflow-auto"
          >
            {agents.map((a) => {
              const selected = targetIds.has(a.agentInstanceId)
              return (
                <li key={a.agentInstanceId}>
                  <button
                    className={`block w-full rounded px-2 py-1 text-left text-sm ${
                      selected
                        ? 'bg-neutral-700 text-neutral-100'
                        : 'text-neutral-300 hover:bg-neutral-800'
                    }`}
                    aria-pressed={selected}
                    onClick={() => toggleManual(a.agentInstanceId)}
                  >
                    {a.name} · {providerLabel(a.providerId)} ·{' '}
                    {RUNTIME_STATE_LABEL[a.runtimeState]}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        {/* Effective target chips — from manual selection and @@ resolution. */}
        {targets.length > 0 && (
          <div>
            <div className="text-xs text-neutral-400">已选目标</div>
            <ul className="mt-1 flex flex-wrap gap-1">
              {targets.map((a) => (
                <li
                  key={a.agentInstanceId}
                  aria-label="已选目标"
                  className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200"
                >
                  {a.name}
                </li>
              ))}
            </ul>
          </div>
        )}

        {resolved.unresolved.length > 0 && (
          <p role="alert" className="text-xs text-amber-400">
            未识别的名称：{resolved.unresolved.join(', ')}
          </p>
        )}

        {resolved.hasAll && (
          <p className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300">
            @@all 已展开为全部实例（{targets.length} 个），确认派发前需再次确认广播。
          </p>
        )}

        <label className="block text-xs text-neutral-400">
          指令
          <textarea
            aria-label="指令"
            placeholder="输入指令，可用 @@<agent-name> 或 @@all…"
            className="mt-1 min-h-[3rem] w-full resize-none rounded bg-neutral-950 px-2 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600"
            value={instruction}
            onChange={(e) => {
              setInstruction(e.target.value)
              setAwaitingBroadcast(false)
            }}
          />
        </label>

        {/* Preview — targets, instruction, resource scope, queue position. */}
        {targets.length > 0 && instruction.trim().length > 0 && (
          <section
            role="region"
            aria-label="派发预览"
            className="space-y-1 rounded border border-neutral-700 bg-neutral-950/60 p-2 text-xs text-neutral-300"
          >
            <div>
              <span className="text-neutral-500">目标：</span>
              {targets.map((a) => a.name).join('、')}
            </div>
            <div>
              <span className="text-neutral-500">指令：</span>
              {instruction.trim()}
            </div>
            <div>
              <span className="text-neutral-500">资源范围：</span>
              当前 Project（{project.name}）绑定资源
            </div>
            <div>
              <span className="text-neutral-500">队列位置：</span>约第 {queuePosition} 位
            </div>
          </section>
        )}

        {notice && (
          <p role="alert" className="text-xs text-red-400">
            {notice}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
            disabled={targets.length === 0 || instruction.trim().length === 0}
            onClick={() => void confirm()}
          >
            {awaitingBroadcast ? '确认广播' : '确认派发'}
          </button>
        </div>

        {awaitingBroadcast && (
          <div
            role="dialog"
            aria-label="确认广播派发"
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/70"
          >
            <div className="w-72 space-y-3 rounded-lg border border-neutral-600 bg-neutral-900 p-4">
              <h4 className="text-sm font-medium text-neutral-100">
                确认广播派发
              </h4>
              <p className="text-xs text-neutral-400">
                本次派发将向 {targets.length} 个实例发送同一指令，每个目标会生成独立的
                Dispatch。是否继续？
              </p>
              <div className="flex justify-end gap-2">
                <button
                  className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
                  onClick={() => setAwaitingBroadcast(false)}
                >
                  取消
                </button>
                <button
                  className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-100 hover:bg-neutral-600"
                  onClick={() => void confirm()}
                >
                  确认广播
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
