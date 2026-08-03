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
  CommandResult,
  LayoutNode,
  LayoutOperation,
  PanelId,
  ProjectViewModel,
  QueueItemId,
  SplitNodeId,
  WorkbenchViewModel,
  WorktreeChangesViewModel
} from './workbench/contract'
import { id } from './workbench/contract'
import { clampRatio } from './workbench/layout-reducer'
import {
  providerLabel,
  RUNTIME_STATE_LABEL,
  TERMINAL_STATE_LABEL
} from './agent-display'
import type { SendCommand } from './agents-surface'
import {
  getProjectDispatchBlockReason,
  isAgentBusy,
  isTerminalExecutionSlotOccupied
} from './workbench/dispatchability'

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
  sendCommand: SendCommand
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
  sendLayout: sendLayoutCommand,
  sendCommand
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  openAttentionTargets: Set<string>
  sendLayout: (
    operation: LayoutOperation,
    expectedRevision?: number
  ) => Promise<CommandResult>
  sendCommand: SendCommand
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
    sendCommand,
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
          project={project}
          agent={activeAgent}
          snapshot={snapshot}
          sendCommand={ctx.sendCommand}
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
          <ChangesView
            agent={agent}
            changes={snapshot.changes}
            sendCommand={sendCommand}
          />
        )}
        {subView === 'terminal' && (
          <TerminalStateView
            project={project}
            agent={agent}
            sendCommand={sendCommand}
          />
        )}
      </div>

      {/* Queue items for this project — visible across all sub-views */}
      <QueuePanel project={project} snapshot={snapshot} sendCommand={sendCommand} />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Chat sub-view — state text driven only by port-judged facts (#20)
// ---------------------------------------------------------------------------

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
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)

  const lifecycleBlocked =
    agent.runtimeState === 'unavailable' || agent.runtimeState === 'archived'
  const projectBlockReason = getProjectDispatchBlockReason(project)
  const projectBlocked = projectBlockReason !== undefined
  // ADR-0007: structured Run and Terminal PTY are mutually exclusive. While
  // Terminal is opening or active the composer is disabled and shows why.
  const terminalBlocked = isTerminalExecutionSlotOccupied(agent.terminalState)
  const disabled =
    projectBlocked || lifecycleBlocked || terminalBlocked || submitting
  const awaitingInput = agent.runtimeState === 'needs-input'
  const hasQueuedWork = agent.runtimeState === 'queued' || agent.queueDepth > 0

  const submit = async () => {
    const instruction = draft.trim()
    if (!instruction || disabled || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setNotice(null)
    try {
      const result = await sendCommand({
        kind: 'send-agent-instruction',
        projectId: project.projectId,
        agentInstanceId: agent.agentInstanceId,
        instruction,
        // UX-v0.2 §6.3: only an explicitly needs-input Run may be replied to.
        // Any other active state enqueues as the next Run instead of being
        // mistaken for a reply to the current Run.
        mode: awaitingInput ? 'reply-current-run' : 'start-or-queue'
      })
      if (result.ok) {
        setDraft('')
      } else {
        setNotice(result.message)
      }
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="log"
        aria-label="对话记录"
        className="min-h-0 flex-1 overflow-auto"
      >
        {projectBlockReason === 'project-archived' ? (
          <p className="text-neutral-500">
            Project 已归档；仅可查看历史记录，不能发送新指令。
          </p>
        ) : projectBlockReason === 'project-root-unavailable' ? (
          <p className="text-neutral-500">
            Project Root 不可用；仅可查看历史记录，请先恢复或重新定位 Root。
          </p>
        ) : projectBlockReason === 'project-repository-not-ready' ? (
          <p className="text-neutral-500">
            Project 尚未初始化或绑定 Git 仓库；仅可查看历史记录，请先完成 Git
            初始化或绑定。
          </p>
        ) : agent.runtimeState === 'unavailable' ? (
          <p className="text-neutral-500">
            Provider 不可用；当前仅可查看历史记录，修复 Provider 后可恢复。
          </p>
        ) : agent.runtimeState === 'archived' ? (
          <p className="text-neutral-500">
            Agent 已归档；仅可查看历史记录，不能发送新指令。
          </p>
        ) : terminalBlocked ? (
          <p className="text-neutral-500">
            {agent.terminalState === 'opening'
              ? 'Terminal 正在打开或接管中；结构化 Run 与 PTY 互斥，请等待打开完成并结束接管。'
              : 'Terminal 接管中；结构化 Run 与 PTY 互斥，请先结束接管再发送指令。'}
          </p>
        ) : awaitingInput ? (
          <p className="text-neutral-500">
            当前 Run 正在等待输入，可直接回复。
          </p>
        ) : hasQueuedWork && agent.queueDepth > 0 ? (
          <p className="text-neutral-500">
            当前已有 {agent.queueDepth} 项排队；新指令将进入第{' '}
            {agent.queueDepth + 1} 位。
          </p>
        ) : hasQueuedWork ? (
          <p className="text-neutral-500">
            当前 Agent 已在排队；新指令将继续加入下一 Run 队列。
          </p>
        ) : isAgentBusy(agent) ? (
          <p className="text-neutral-500">
            当前有进行中的 Run；新指令将进入下一 Run 队列。
          </p>
        ) : (
          <p className="text-neutral-500">
            暂无对话记录；发送首条消息后才会启动 Run。
          </p>
        )}
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
// Changes sub-view — mock worktree diff, validation, drift and safe merge (#8)
// ---------------------------------------------------------------------------

const FILE_STATUS_LABEL: Record<string, string> = {
  modified: '修改',
  added: '新增',
  deleted: '删除'
}

function ChangesView({
  agent,
  changes,
  sendCommand
}: {
  agent: AgentInstanceViewModel
  changes: WorktreeChangesViewModel[]
  sendCommand: SendCommand
}) {
  const agentChanges = changes.find(
    (c) => c.agentInstanceId === agent.agentInstanceId
  )

  if (!agentChanges) {
    return <p className="text-neutral-500">暂无改动</p>
  }

  const canMerge =
    agentChanges.drift === 'none' &&
    agentChanges.validation.status === 'pass'

  return (
    <div className="space-y-3">
      {/* Drift & validation status */}
      <div className="flex gap-4 text-xs">
        <span
          className={
            agentChanges.drift === 'behind'
              ? 'text-amber-400'
              : 'text-emerald-400'
          }
        >
          {agentChanges.drift === 'behind'
            ? '需要 rebase：base commit 已落后'
            : 'Base 同步'}
        </span>
        <span
          className={
            agentChanges.validation.status === 'fail'
              ? 'text-red-400'
              : agentChanges.validation.status === 'pass'
                ? 'text-emerald-400'
                : 'text-neutral-500'
          }
        >
          验证：{agentChanges.validation.status === 'pass'
            ? '通过'
            : agentChanges.validation.status === 'fail'
              ? `失败${agentChanges.validation.message ? '（' + agentChanges.validation.message + '）' : ''}`
              : '等待中'}
        </span>
        <span className="text-neutral-600">
          base: {agentChanges.baseCommit}
        </span>
      </div>

      {/* Needs rebase notice */}
      {agentChanges.drift === 'behind' && (
        <div className="rounded bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
          主仓库已超前于本 worktree 的 base commit。请先更新 worktree、解冲突并重新验证，再尝试合并。不提供自动 rebase、冲突解决或 force merge。
        </div>
      )}

      {/* File list */}
      <ul className="space-y-1 font-mono text-xs">
        {agentChanges.files.map((file) => (
          <li key={file.path} className="flex items-center gap-2">
            <span className="w-8 text-neutral-500">
              {FILE_STATUS_LABEL[file.status] ?? file.status}
            </span>
            <span className="flex-1 text-neutral-300">{file.path}</span>
            <span className="text-emerald-400">+{file.additions}</span>
            <span className="text-red-400">-{file.deletions}</span>
          </li>
        ))}
      </ul>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          className="rounded bg-blue-700 px-3 py-1 text-xs text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-30"
          disabled={!canMerge}
          title={
            canMerge
              ? '以快进方式合并到主仓库'
              : agentChanges.drift === 'behind'
                ? '需要先 rebase'
                : '验证未通过'
          }
          onClick={() =>
            void sendCommand({
              kind: 'merge-agent-changes',
              agentInstanceId: agent.agentInstanceId
            })
          }
        >
          ff-only 合并
        </button>
        <button
          className="rounded bg-red-950 px-3 py-1 text-xs text-red-400 hover:bg-red-900"
          onClick={() =>
            void sendCommand({
              kind: 'discard-agent-changes',
              agentInstanceId: agent.agentInstanceId
            })
          }
        >
          丢弃改动
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Terminal Takeover — execution slot mutual exclusion (#7)
// ---------------------------------------------------------------------------

const ACTIVE_RUN_STATES: ReadonlySet<string> = new Set([
  'starting',
  'running',
  'finishing',
  'needs-input',
  'permission-requested'
])

function TerminalStateView({
  project,
  agent,
  sendCommand
}: {
  project: ProjectViewModel
  agent: AgentInstanceViewModel
  sendCommand: SendCommand
}) {
  const ts = agent.terminalState
  const isTakeover = ts === 'active'
  const isOpening = ts === 'opening'
  const isFailed = ts === 'failed'
  const runBlocks = ACTIVE_RUN_STATES.has(agent.runtimeState)
  const unavailable =
    agent.runtimeState === 'unavailable' || agent.runtimeState === 'archived'
  const canOpen = !isTakeover && !isOpening && !runBlocks && !unavailable

  const statusText = isTakeover
    ? 'Terminal 已接管'
    : isOpening
      ? 'Terminal 正在打开'
      : isFailed
        ? 'Terminal 打开失败'
        : 'Terminal 未接管'

  const descText = isTakeover
    ? '执行槽被 Terminal 占用，结构化 Run 被阻止。关闭 Tab 不会释放执行槽，需显式结束接管。'
    : isOpening
      ? '正在初始化 Terminal…'
      : isFailed
        ? '上次打开 Terminal 失败。可以重试或保持关闭。'
        : runBlocks
          ? 'Agent 正在运行结构化 Run，不能接管 Terminal。'
          : unavailable
            ? 'Agent 当前不可用，不能接管 Terminal。'
            : '打开 Terminal 将占用执行槽并阻止结构化 Run。'

  return (
    <div className="space-y-2">
      <p className="text-neutral-400">{statusText}</p>
      <p className="text-xs text-neutral-600">{descText}</p>
      {(isTakeover || isFailed) && (
        <button
          className="rounded bg-red-950 px-3 py-1 text-xs text-red-400 hover:bg-red-900"
          onClick={() =>
            void sendCommand({
              kind: 'set-terminal-takeover',
              projectId: project.projectId,
              agentInstanceId: agent.agentInstanceId,
              operation: 'close'
            })
          }
        >
          结束接管
        </button>
      )}
      {!isTakeover && !isOpening && (
        <button
          className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-30"
          disabled={!canOpen}
          title={
            runBlocks
              ? 'Agent 正在运行'
              : unavailable
                ? 'Agent 不可用'
                : undefined
          }
          onClick={() =>
            void sendCommand({
              kind: 'set-terminal-takeover',
              projectId: project.projectId,
              agentInstanceId: agent.agentInstanceId,
              operation: 'open'
            })
          }
        >
          打开 Terminal
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Queue Panel — visible queue depth, reorder, priority, cancel (#7)
// ---------------------------------------------------------------------------

const PRIORITY_LABEL: Record<string, string> = {
  low: '低',
  normal: '普通',
  high: '高'
}

function QueuePanel({
  project,
  snapshot,
  sendCommand
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  sendCommand: SendCommand
}) {
  const queueItems = snapshot.queue
    .filter((q) => q.projectId === project.projectId)
    .sort((a, b) => a.position - b.position)

  if (queueItems.length === 0) return null

  const manage = (
    queueItemId: QueueItemId,
    operation: 'cancel' | 'move-earlier' | 'move-later' | 'raise-priority' | 'lower-priority'
  ) => {
    void sendCommand({
      kind: 'manage-queue',
      projectId: project.projectId,
      queueItemId,
      operation
    })
  }

  return (
    <div
      role="region"
      aria-label="队列"
      className="mt-3 space-y-1.5 border-t border-neutral-800 pt-2"
    >
      <div className="text-xs text-neutral-500">
        队列深度：{queueItems.length}
      </div>
      {queueItems.map((item) => {
        const agentName =
          snapshot.agents.find(
            (a) => a.agentInstanceId === item.agentInstanceId
          )?.name ?? item.agentInstanceId
        return (
          <div
            key={item.queueItemId}
            className="flex items-center gap-2 rounded bg-neutral-900 px-2 py-1 text-xs"
          >
            <span className="w-5 text-neutral-600">{item.position}</span>
            <span className="flex-1 text-neutral-300">{agentName}</span>
            <span className="text-neutral-500">
              {PRIORITY_LABEL[item.priority] ?? item.priority}
            </span>
            <button
              aria-label="上移"
              className="text-neutral-500 hover:text-neutral-200 disabled:opacity-20"
              disabled={item.position <= 1}
              onClick={() => manage(item.queueItemId, 'move-earlier')}
            >
              ↑
            </button>
            <button
              aria-label="下移"
              className="text-neutral-500 hover:text-neutral-200 disabled:opacity-20"
              disabled={item.position >= queueItems.length}
              onClick={() => manage(item.queueItemId, 'move-later')}
            >
              ↓
            </button>
            <button
              aria-label="提高优先级"
              className="text-neutral-500 hover:text-neutral-200"
              onClick={() => manage(item.queueItemId, 'raise-priority')}
            >
              ⬆
            </button>
            <button
              aria-label="降低优先级"
              className="text-neutral-500 hover:text-neutral-200"
              onClick={() => manage(item.queueItemId, 'lower-priority')}
            >
              ⬇
            </button>
            <button
              aria-label="取消排队"
              className="text-red-400 hover:text-red-300"
              onClick={() => manage(item.queueItemId, 'cancel')}
            >
              取消排队
            </button>
          </div>
        )
      })}
    </div>
  )
}
