import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent
} from 'react'
import type {
  AgentInstanceId,
  AgentInstanceViewModel,
  AgentRuntimeState,
  CommandResult,
  LayoutNode,
  LayoutOperation,
  PanelId,
  ProjectViewModel,
  SplitNodeId,
  WorkbenchViewModel
} from './workbench/contract'
import { id } from './workbench/contract'
import { clampRatio } from './workbench/layout-reducer'
import {
  providerLabel,
  RUNTIME_STATE_LABEL,
  TERMINAL_STATE_LABEL
} from './agent-display'

/**
 * Workspace — the free split tree of Agent Panels (#4).
 *
 * Renders `project.layout` recursively and turns every user gesture into a
 * typed `change-layout` command. The component owns NO layout rules: splits,
 * pruning, migration and clamping all live in the shared layout reducer
 * behind the WorkbenchPort. Local state is limited to drag-in-progress,
 * divider preview and recoverable notices. Layout commands never touch
 * runtime, PTY, session or instance lifecycle.
 */

// ---------------------------------------------------------------------------
// Shared render context — threaded through the recursive tree
// ---------------------------------------------------------------------------

interface LayoutRenderContext {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  openAttentionTargets: Set<string>
  previewRatios: Partial<Record<string, number>>
  draggingTab: { tabId: AgentInstanceId; startRevision: number } | null
  panelCount: number
  layoutRevision: number
  sendLayout: (
    operation: LayoutOperation,
    expectedRevision?: number
  ) => Promise<CommandResult>
  onPreviewRatio: (splitNodeId: SplitNodeId, ratio: number) => void
  onCommitRatio: (
    splitNodeId: SplitNodeId,
    ratio: number,
    expectedRevision: number
  ) => void
  onCancelRatio: (splitNodeId: SplitNodeId) => void
  onDragTabStart: (tab: AgentInstanceId) => void
  onDragTabEnd: () => void
  onRequestClosePanel: (panelId: PanelId) => void
}

// ---------------------------------------------------------------------------
// Workspace area
// ---------------------------------------------------------------------------

export function WorkspaceArea({
  project,
  snapshot,
  openAttentionTargets,
  sendLayout: sendLayoutCommand
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  openAttentionTargets: Set<string>
  sendLayout: (
    operation: LayoutOperation,
    expectedRevision?: number
  ) => Promise<CommandResult>
}) {
  const layout = project.layout
  const [draggingTab, setDraggingTab] = useState<{
    tabId: AgentInstanceId
    startRevision: number
  } | null>(null)
  const [previewRatios, setPreviewRatios] = useState<
    Partial<Record<string, number>>
  >({})
  const [closingPanel, setClosingPanel] = useState<{
    panelId: PanelId
    startRevision: number
  } | null>(null)
  const [migrateTarget, setMigrateTarget] = useState('')

  // Backstop: an authoritative layout change invalidates any in-flight
  // drag — its drop would stale-reject anyway, so hide the zones now
  // instead of leaving a ghost overlay behind.
  useEffect(() => {
    setDraggingTab(null)
  }, [snapshot.revision])

  /**
   * All layout commands go through the surface-level handler, which shows
   * a recoverable notice on rejection. A rejection never mutates the
   * snapshot (rejection purity), so local previews are simply dropped and
   * the tree keeps showing the authoritative layout.
   */
  const sendLayout = async (
    operation: LayoutOperation,
    expectedRevision?: number
  ): Promise<CommandResult> => {
    const result = await sendLayoutCommand(operation, expectedRevision)
    if (!result.ok) {
      setPreviewRatios({})
    }
    return result
  }

  if (!layout.root || Object.keys(layout.panels).length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-neutral-500">
          尚未打开任何 Agent，请从左侧目录选择。
        </p>
      </div>
    )
  }

  const requestClosePanel = (panelId: PanelId) => {
    const panel = layout.panels[panelId]
    if (!panel) return
    // Empty panels close directly; a panel with tabs needs a migration
    // target chosen in the dialog first.
    if (panel.tabs.length === 0) {
      void sendLayout({ kind: 'close-panel', panelId })
      return
    }
    const firstOther = treePanelOrder(layout.root).find((p) => p !== panelId)
    if (!firstOther) return
    setMigrateTarget(firstOther)
    // The confirmation's baseline revision: the user confirms the tab list
    // they SAW. If the panel authoritatively gains or loses tabs meanwhile,
    // the stale confirmation must not dispose of tabs the user never saw.
    setClosingPanel({ panelId, startRevision: snapshot.revision })
  }

  const ctx: LayoutRenderContext = {
    project,
    snapshot,
    openAttentionTargets,
    previewRatios,
    draggingTab,
    panelCount: Object.keys(layout.panels).length,
    layoutRevision: snapshot.revision,
    sendLayout,
    onPreviewRatio: (splitNodeId, ratio) =>
      setPreviewRatios((prev) => ({ ...prev, [splitNodeId]: ratio })),
    onCommitRatio: (splitNodeId, ratio, expectedRevision) => {
      setPreviewRatios((prev) => {
        const next = { ...prev }
        delete next[splitNodeId]
        return next
      })
      // The commit carries the gesture's baseline revision: if the
      // authoritative layout moved on meanwhile, the port rejects it as
      // stale and the surface shows the recoverable notice.
      void sendLayout({ kind: 'resize-split', splitNodeId, ratio }, expectedRevision)
    },
    onCancelRatio: (splitNodeId) =>
      setPreviewRatios((prev) => {
        const next = { ...prev }
        delete next[splitNodeId]
        return next
      }),
    onDragTabStart: (tab) =>
      // The drag's baseline revision: a drop dispatches against it, so a
      // drop that lands after an authoritative layout change stale-rejects
      // instead of overwriting it.
      setDraggingTab({ tabId: tab, startRevision: snapshot.revision }),
    onDragTabEnd: () => setDraggingTab(null),
    onRequestClosePanel: requestClosePanel
  }

  const closingPanelRecord = closingPanel
    ? layout.panels[closingPanel.panelId]
    : null

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <LayoutNodeView node={layout.root} ctx={ctx} />
      </div>
      {closingPanel && closingPanelRecord && (
        <ClosePanelDialog
          layout={layout}
          closingPanelId={closingPanel.panelId}
          snapshot={snapshot}
          migrateTarget={migrateTarget}
          onSelectTarget={setMigrateTarget}
          onCancel={() => setClosingPanel(null)}
          onConfirm={() => {
            if (!migrateTarget) return
            void sendLayout(
              {
                kind: 'close-panel',
                panelId: closingPanel.panelId,
                migrateToPanelId: id(migrateTarget, 'PanelId')
              },
              closingPanel.startRevision
            ).then(() => {
              // Close after EVERY decision. A stale rejection response may
              // arrive before the refreshed snapshot is rendered — keeping
              // the dialog open would let the user re-confirm against a
              // revision they have never seen. Re-opening rebuilds the
              // candidates from the latest rendered layout instead.
              setClosingPanel(null)
            })
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Recursive split-tree rendering
// ---------------------------------------------------------------------------

/** Panel IDs in depth-first tree order — the rendered left-to-right order. */
function treePanelOrder(node: LayoutNode | null): PanelId[] {
  if (!node) return []
  if (node.kind === 'panel') return [node.panelId]
  return [...treePanelOrder(node.first), ...treePanelOrder(node.second)]
}

function LayoutNodeView({
  node,
  ctx
}: {
  node: LayoutNode
  ctx: LayoutRenderContext
}) {
  if (node.kind === 'panel') {
    return <PanelView panelId={node.panelId} ctx={ctx} />
  }
  const ratio = ctx.previewRatios[node.splitNodeId] ?? node.ratio
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 ${
        node.direction === 'horizontal' ? 'flex-row' : 'flex-col'
      }`}
    >
      <div
        className="flex min-h-0 min-w-0"
        style={{ flexBasis: `${Math.round(ratio * 100)}%` }}
      >
        <LayoutNodeView node={node.first} ctx={ctx} />
      </div>
      <Divider
        direction={node.direction}
        splitNodeId={node.splitNodeId}
        ratio={ratio}
        layoutRevision={ctx.layoutRevision}
        onPreview={ctx.onPreviewRatio}
        onCommit={ctx.onCommitRatio}
        onCancel={ctx.onCancelRatio}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <LayoutNodeView node={node.second} ctx={ctx} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Divider — keyboard and pointer resize with local preview
// ---------------------------------------------------------------------------

const KEYBOARD_RATIO_STEP = 0.05

function Divider({
  direction,
  splitNodeId,
  ratio,
  layoutRevision,
  onPreview,
  onCommit,
  onCancel
}: {
  direction: 'horizontal' | 'vertical'
  splitNodeId: SplitNodeId
  ratio: number
  layoutRevision: number
  onPreview: (splitNodeId: SplitNodeId, ratio: number) => void
  onCommit: (
    splitNodeId: SplitNodeId,
    ratio: number,
    expectedRevision: number
  ) => void
  onCancel: (splitNodeId: SplitNodeId) => void
}) {
  const dragRef = useRef<{
    startPos: number
    startRatio: number
    lastRatio: number
    startRevision: number
  } | null>(null)

  /**
   * Drops the in-flight gesture WITHOUT committing: the pointer was
   * cancelled, capture was lost, or the authoritative layout moved on
   * mid-gesture. The preview is cleared so the tree falls back to the
   * authoritative ratio.
   */
  const cancelDrag = () => {
    if (!dragRef.current) return
    dragRef.current = null
    onCancel(splitNodeId)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
    const shrink = direction === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
    // Keyboard commits bind to the revision of the render the user saw;
    // a same-batch authoritative event makes them stale-reject instead of
    // overwriting the newer ratio.
    if (e.key === grow) {
      e.preventDefault()
      onCommit(
        splitNodeId,
        clampRatio(ratio + KEYBOARD_RATIO_STEP),
        layoutRevision
      )
    } else if (e.key === shrink) {
      e.preventDefault()
      onCommit(
        splitNodeId,
        clampRatio(ratio - KEYBOARD_RATIO_STEP),
        layoutRevision
      )
    }
  }

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    // The gesture's baseline: both the starting ratio and the revision it
    // was read from. Committing against a newer revision would silently
    // overwrite whatever the newer snapshot changed.
    dragRef.current = {
      startPos: direction === 'horizontal' ? e.clientX : e.clientY,
      startRatio: ratio,
      lastRatio: ratio,
      startRevision: layoutRevision
    }
  }

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.startRevision !== layoutRevision) {
      cancelDrag()
      return
    }
    const parent = e.currentTarget.parentElement
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    const size = direction === 'horizontal' ? rect.width : rect.height
    // Without layout (e.g. jsdom) there is nothing to measure — skip.
    if (!size) return
    const pos = direction === 'horizontal' ? e.clientX : e.clientY
    const next = clampRatio(drag.startRatio + (pos - drag.startPos) / size)
    drag.lastRatio = next
    onPreview(splitNodeId, next)
  }

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.startRevision !== layoutRevision) {
      cancelDrag()
      return
    }
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (drag.lastRatio !== drag.startRatio) {
      // Commit against the revision captured at pointer down — the only
      // baseline this ratio math is valid for.
      onCommit(splitNodeId, drag.lastRatio, drag.startRevision)
    }
  }

  return (
    <div
      role="separator"
      aria-label="调整分割比例"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={10}
      aria-valuemax={90}
      tabIndex={0}
      className={`shrink-0 bg-neutral-800 hover:bg-neutral-600 ${
        direction === 'horizontal'
          ? 'w-1 cursor-col-resize'
          : 'h-1 cursor-row-resize'
      }`}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={cancelDrag}
      onLostPointerCapture={cancelDrag}
    />
  )
}

// ---------------------------------------------------------------------------
// Panel — toolbar, unique Agent Tabs, agent view, drop zones
// ---------------------------------------------------------------------------

function PanelView({ panelId, ctx }: { panelId: PanelId; ctx: LayoutRenderContext }) {
  const { project, snapshot, openAttentionTargets, sendLayout } = ctx
  const panel = project.layout.panels[panelId]
  if (!panel) return null
  const activeAgent = snapshot.agents.find(
    (a) => a.agentInstanceId === panel.activeTabId
  )

  const dropOperation = (
    zone: 'center' | 'left' | 'right' | 'top' | 'bottom',
    tabId: AgentInstanceId
  ): LayoutOperation =>
    zone === 'center'
      ? { kind: 'move-tab', agentInstanceId: tabId, targetPanelId: panelId }
      : {
          kind: 'open-tab-in-new-panel',
          agentInstanceId: tabId,
          direction:
            zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical',
          position: zone === 'left' || zone === 'top' ? 'before' : 'after',
          relativeToPanelId: panelId
        }

  const dropZone = (
    zone: 'center' | 'left' | 'right' | 'top' | 'bottom',
    label: string,
    className: string
  ) => (
    <div
      key={zone}
      aria-label={label}
      className={`pointer-events-auto absolute border border-dashed border-transparent hover:border-neutral-500 hover:bg-neutral-700/30 ${className}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(e) => {
        e.preventDefault()
        const tabId = (e.dataTransfer.getData('text/plain') ||
          ctx.draggingTab?.tabId) as AgentInstanceId | null
        // Dispatch against the revision captured at drag start — a drop
        // landing after an authoritative layout change stale-rejects.
        const baseline = ctx.draggingTab?.startRevision
        // The gesture is over once a drop lands — clear it synchronously.
        // After a successful structural drop the source tab node is
        // unmounted, and a dragend dispatched to a detached node never
        // reaches the React root, so onDragEnd alone cannot be relied on.
        ctx.onDragTabEnd()
        if (tabId) {
          void sendLayout(dropOperation(zone, tabId), baseline)
        }
      }}
    />
  )

  return (
    <div
      role="group"
      aria-label="Agent 面板"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-neutral-800 px-1.5 py-1">
        <button
          className="rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          onClick={() =>
            void sendLayout({
              kind: 'split-panel',
              panelId,
              direction: 'horizontal'
            })
          }
        >
          向右分割
        </button>
        <button
          className="rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          onClick={() =>
            void sendLayout({
              kind: 'split-panel',
              panelId,
              direction: 'vertical'
            })
          }
        >
          向下分割
        </button>
        <span className="flex-1" />
        {ctx.panelCount > 1 && (
          <button
            className="rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            onClick={() => ctx.onRequestClosePanel(panelId)}
          >
            关闭 Panel
          </button>
        )}
      </div>

      <div
        role="tablist"
        aria-label="Agent 标签"
        className="flex shrink-0 overflow-x-auto border-b border-neutral-800"
      >
        {panel.tabs.map((tabId) => {
          const agent = snapshot.agents.find(
            (a) => a.agentInstanceId === tabId
          )
          if (!agent) return null
          const selected = tabId === panel.activeTabId
          return (
            <div
              key={tabId}
              role="tab"
              aria-selected={selected}
              tabIndex={0}
              draggable
              className={`flex cursor-pointer items-center gap-1.5 border-r border-neutral-800 px-3 py-1.5 text-sm ${
                selected
                  ? 'bg-neutral-900 text-neutral-100'
                  : 'text-neutral-500 hover:bg-neutral-900/60'
              }`}
              onClick={() =>
                void sendLayout({
                  kind: 'activate-tab',
                  panelId,
                  agentInstanceId: tabId
                })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void sendLayout({
                    kind: 'activate-tab',
                    panelId,
                    agentInstanceId: tabId
                  })
                }
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', tabId)
                e.dataTransfer.effectAllowed = 'move'
                ctx.onDragTabStart(tabId)
              }}
              onDragEnd={ctx.onDragTabEnd}
            >
              <span>{agent.name}</span>
              {openAttentionTargets.has(tabId) && (
                <span
                  role="img"
                  aria-label="有待处理事项"
                  className="text-amber-400"
                >
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
                  void sendLayout({
                    kind: 'close-tab',
                    panelId,
                    agentInstanceId: tabId
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
          agent={activeAgent}
          snapshot={snapshot}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-neutral-500">未选择 Agent</p>
        </div>
      )}

      {ctx.draggingTab && (
        <div className="pointer-events-none absolute inset-0 z-10">
          {dropZone('top', '拖到上侧分屏', 'left-1/4 right-1/4 top-0 h-1/4')}
          {dropZone(
            'bottom',
            '拖到下侧分屏',
            'bottom-0 left-1/4 right-1/4 h-1/4'
          )}
          {dropZone('left', '拖到左侧分屏', 'bottom-1/4 left-0 top-1/4 w-1/4')}
          {dropZone(
            'right',
            '拖到右侧分屏',
            'bottom-1/4 right-0 top-1/4 w-1/4'
          )}
          {dropZone(
            'center',
            '移动到该 Panel',
            'bottom-1/4 left-1/4 right-1/4 top-1/4'
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Close-panel dialog — choose a migration target for the remaining tabs
// ---------------------------------------------------------------------------

function ClosePanelDialog({
  layout,
  closingPanelId,
  snapshot,
  migrateTarget,
  onSelectTarget,
  onCancel,
  onConfirm
}: {
  layout: ProjectViewModel['layout']
  closingPanelId: PanelId
  snapshot: WorkbenchViewModel
  migrateTarget: string
  onSelectTarget: (panelId: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  // Migration candidates in rendered (tree) order, so the option labels
  // can point at a distinguishable position even when several panels are
  // empty. Non-empty panels are identified by their first tab's name —
  // agent names are unique within a project.
  const candidates = treePanelOrder(layout.root).filter(
    (panelId) => panelId !== closingPanelId
  )
  const emptyTotal = candidates.filter(
    (panelId) => layout.panels[panelId].tabs.length === 0
  ).length
  let emptySeen = 0
  const options = candidates.map((panelId) => {
    const panel = layout.panels[panelId]
    if (panel.tabs.length === 0) {
      emptySeen += 1
      return {
        panelId,
        label: emptyTotal > 1 ? `空 Panel（${emptySeen}）` : '空 Panel'
      }
    }
    const first = snapshot.agents.find(
      (a) => a.agentInstanceId === panel.tabs[0]
    )
    return { panelId, label: `${first?.name ?? 'Agent'} 的 Panel` }
  })

  return (
    <div
      role="dialog"
      aria-label="关闭 Panel"
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/60"
    >
      <div className="w-80 space-y-3 rounded-lg border border-neutral-700 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-100">关闭 Panel</h3>
        <p className="text-xs text-neutral-400">
          该 Panel 仍含有 Agent 标签，关闭前请选择迁移目标；标签只改变视图位置，不影响运行状态。
        </p>
        <label className="block text-xs text-neutral-400">
          迁移目标 Panel
          <select
            aria-label="迁移目标 Panel"
            className="mt-1 w-full rounded bg-neutral-950 px-2 py-1 text-sm text-neutral-200 outline-none"
            value={migrateTarget}
            onChange={(e) => onSelectTarget(e.target.value)}
          >
            {options.map((option) => (
              <option key={option.panelId} value={option.panelId}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <button
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="rounded bg-neutral-700 px-2 py-1 text-xs text-neutral-100 hover:bg-neutral-600"
            onClick={onConfirm}
          >
            迁移并关闭
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agent View — four stable secondary entries (#3, unchanged)
// ---------------------------------------------------------------------------

type AgentSubView = 'chat' | 'activity' | 'changes' | 'terminal'

const SUB_VIEWS: Array<{ view: AgentSubView; label: string }> = [
  { view: 'chat', label: '对话' },
  { view: 'activity', label: '活动' },
  { view: 'changes', label: '改动' },
  { view: 'terminal', label: 'Terminal' }
]

function AgentView({
  agent,
  snapshot
}: {
  agent: AgentInstanceViewModel
  snapshot: WorkbenchViewModel
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
        {subView === 'chat' && <ChatState agent={agent} />}
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
        {subView === 'changes' && <p className="text-neutral-500">暂无改动</p>}
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

function ChatState({ agent }: { agent: AgentInstanceViewModel }) {
  if (agent.runtimeState === 'unavailable') {
    return (
      <p className="text-neutral-500">
        Provider 不可用；当前仅可查看历史记录，修复 Provider 后可恢复。
      </p>
    )
  }
  if (ACTIVE_RUN_STATES.has(agent.runtimeState) || agent.activeRunId) {
    return (
      <p className="text-neutral-500">
        当前有进行中的 Run；结构化对话内容将在真实执行通道接入后展示。
      </p>
    )
  }
  return (
    <p className="text-neutral-500">
      暂无对话记录；发送首条消息后才会启动 Run。
    </p>
  )
}
