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
import { activityKindLabel } from './activity-display'
import { clampRatio } from './workbench/layout-reducer'
import {
  providerLabel,
  TERMINAL_STATE_LABEL,
  WORKTREE_MODE_LABEL
} from './agent-display'
import { agentDisplayState, AGENT_DISPLAY_STATE_LABEL } from './agent-state-selectors'
import { StatusDot, statusDotState } from './status-dot'
import { ProviderIcon } from './provider-icon'
import type { PlanDispatch, SendCommand } from './agents-surface'
import type { ProjectDispatchBlockReason } from './workbench/dispatchability'
import { useDispatchPlan } from './use-dispatch-plan'
import {
  getProjectDispatchBlockReason,
  isActiveStructuredRunState,
  isTerminalExecutionSlotOccupied
} from './workbench/dispatchability'
import {
  stepQueuePriority,
  type QueuePriority
} from './workbench/queue-priority'

/**
 * Workspace — the free split tree of Agent Panels (#4), plus temporary
 * Focus, the Analysis preset, keyboard parity and 4+ panel density (#5).
 *
 * Renders `project.layout` recursively and turns every user gesture into a
 * typed `change-layout` command. The component owns NO layout rules: splits,
 * pruning, migration and clamping all live in the shared layout reducer
 * behind the WorkbenchPort. Local state is limited to drag-in-progress,
 * divider preview, the dismissed density hint and recoverable notices.
 * Layout commands never touch runtime, PTY, session or instance lifecycle.
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
  /** #77: the panel whose tab strip is currently being hovered and the insertion index. */
  tabStripInsertion: { panelId: PanelId; index: number } | null
  panelCount: number
  layoutRevision: number
  temporaryFocusPanelId?: PanelId
  sendLayout: (
    operation: LayoutOperation,
    expectedRevision?: number
  ) => Promise<CommandResult>
  planDispatch: PlanDispatch
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
  onTabStripInsertion: (insertion: { panelId: PanelId; index: number } | null) => void
  onRequestTabFocus: (tab: AgentInstanceId) => number
  onCancelTabFocus: (token: number) => void
  onRequestClosePanel: (panelId: PanelId) => void
}

// ---------------------------------------------------------------------------
// Workspace area
// ---------------------------------------------------------------------------

export function WorkspaceArea({
  project,
  snapshot,
  openAttentionTargets,
  planDispatch,
  sendLayout: sendLayoutCommand,
  sendCommand,
  onFocusExitFallback
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  openAttentionTargets: Set<string>
  planDispatch: PlanDispatch
  sendLayout: (
    operation: LayoutOperation,
    expectedRevision?: number
  ) => Promise<CommandResult>
  sendCommand: SendCommand
  onFocusExitFallback: (agentInstanceId?: AgentInstanceId) => void
}) {
  const layout = project.layout
  const [draggingTab, setDraggingTab] = useState<{
    tabId: AgentInstanceId
    startRevision: number
  } | null>(null)
  // #77: tracks which panel's tab strip is hovered and the insertion index
  // computed from the pointer position relative to tab centers.
  const [tabStripInsertion, setTabStripInsertion] = useState<{
    panelId: PanelId
    index: number
  } | null>(null)
  const [previewRatios, setPreviewRatios] = useState<
    Partial<Record<string, number>>
  >({})
  const [closingPanel, setClosingPanel] = useState<{
    panelId: PanelId
    startRevision: number
  } | null>(null)
  const [migrateTarget, setMigrateTarget] = useState('')
  const [densityHintDismissed, setDensityHintDismissed] = useState(false)

  // Backstop: an authoritative layout change invalidates any in-flight
  // drag — its drop would stale-reject anyway, so hide the zones now
  // instead of leaving a ghost overlay behind.
  useEffect(() => {
    setDraggingTab(null)
    setTabStripInsertion(null)
  }, [snapshot.revision])

  // Temporary Focus: render only the focused panel. The split tree itself
  // is never touched by Focus, so exiting restores it losslessly (#5).
  const focusPanelId =
    layout.temporaryFocusPanelId && layout.panels[layout.temporaryFocusPanelId]
      ? layout.temporaryFocusPanelId
      : undefined

  // Focus management for the Focus view (#24 review): entering Focus
  // unmounts the trigger button, so keyboard focus is moved into the Focus
  // UI; exiting restores it to the original trigger. If pruning removes
  // the complete layout, the owning surface restores focus to the matching
  // Directory instance (or its stable fallback). Without this, focus falls
  // back to body and Escape never reaches the handler.
  const exitFocusButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusPanelId = useRef<PanelId | undefined>(undefined)
  const previousFocusAgentId = useRef<AgentInstanceId | undefined>(undefined)
  useEffect(() => {
    const previous = previousFocusPanelId.current
    if (focusPanelId) {
      previousFocusAgentId.current =
        layout.panels[focusPanelId]?.activeTabId
      if (previous === undefined) exitFocusButtonRef.current?.focus()
    } else if (!focusPanelId && previous) {
      const trigger = findFocusTrigger(previous)
      if (trigger) {
        trigger.focus()
      } else {
        // The original trigger is gone (the focused panel was pruned with
        // its last tab): land on the panel the reducer now points at —
        // its Focus trigger, else its active tab.
        const fallbackPanelId = layout.focusedPanelId
        const fallbackTabId = fallbackPanelId
          ? layout.panels[fallbackPanelId]?.activeTabId
          : undefined
        const fallback =
          (fallbackPanelId ? findFocusTrigger(fallbackPanelId) : null) ??
          (fallbackTabId ? findRenderedTab(fallbackTabId) : null)
        if (fallback) fallback.focus()
        else onFocusExitFallback(previousFocusAgentId.current)
      }
      previousFocusAgentId.current = undefined
    }
    previousFocusPanelId.current = focusPanelId
  }, [
    focusPanelId,
    layout.focusedPanelId,
    layout.panels,
    onFocusExitFallback
  ])

  // Keyboard moves rebuild the tab node elsewhere in the tree. Restore
  // intents are kept per gesture (own token and baseline revision): only
  // once an authoritative layout NEWER than an intent's baseline has
  // rendered (command response and view-model-updated may arrive in any
  // order) is the tab looked up by its raw ID and focused. An overlapping
  // stale-rejected gesture cancels only its own intent — never an earlier
  // succeeded one's pending restore (#24 round-2/round-3 review).
  const tabFocusIntentCounter = useRef(0)
  const [pendingTabFocus, setPendingTabFocus] = useState<
    Array<{ tabId: AgentInstanceId; startRevision: number; token: number }>
  >([])
  useEffect(() => {
    if (pendingTabFocus.length === 0) return
    const fulfilled = pendingTabFocus.filter(
      (intent) => snapshot.revision > intent.startRevision
    )
    if (fulfilled.length === 0) return
    const latest = fulfilled[fulfilled.length - 1]
    findRenderedTab(latest.tabId)?.focus()
    setPendingTabFocus((prev) =>
      prev.filter(
        (intent) => !fulfilled.some((done) => done.token === intent.token)
      )
    )
  }, [pendingTabFocus, snapshot])

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
    // #92 spec 5: empty conversation area — guided entry with suggested
    // actions instead of a bare placeholder.
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-sm rounded-xl border border-line bg-paper px-6 py-5 text-center shadow-card">
          <div
            aria-hidden="true"
            className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-brand-soft text-[24px]"
          >
            ⌘
          </div>
          <h3 className="text-sm font-semibold text-ink">
            尚未打开 Agent
          </h3>
          <p className="mt-1.5 text-xs text-muted">
            从左侧 Agent Directory 选择一个实例开始对话，
            或点击「新建 Agent」创建第一个。
          </p>
        </div>
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

  // Temporary Focus renders only the focused panel; focusPanelId is
  // computed above, next to the focus-management effects.

  const ctx: LayoutRenderContext = {
    project,
    snapshot,
    openAttentionTargets,
    previewRatios,
    draggingTab,
    panelCount: Object.keys(layout.panels).length,
    layoutRevision: snapshot.revision,
    ...(focusPanelId ? { temporaryFocusPanelId: focusPanelId } : {}),
    sendLayout,
    planDispatch,
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
    onDragTabEnd: () => {
      setDraggingTab(null)
      setTabStripInsertion(null)
    },
    onTabStripInsertion: setTabStripInsertion,
    tabStripInsertion,
    onRequestTabFocus: (tab) => {
      const token = ++tabFocusIntentCounter.current
      setPendingTabFocus((prev) => [
        ...prev,
        { tabId: tab, startRevision: snapshot.revision, token }
      ])
      return token
    },
    onCancelTabFocus: (token) =>
      setPendingTabFocus((prev) =>
        prev.filter((intent) => intent.token !== token)
      ),
    onRequestClosePanel: requestClosePanel
  }

  const closingPanelRecord = closingPanel
    ? layout.panels[closingPanel.panelId]
    : null

  const panelCount = Object.keys(layout.panels).length

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {focusPanelId ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-line bg-raised px-2 py-1">
            <span className="flex-1 text-xs text-muted">
              Focus 模式：仅显示当前 Panel，布局保持不变
            </span>
            <button
              ref={exitFocusButtonRef}
              aria-label="退出独占"
              aria-keyshortcuts="Escape"
              className="mini-button"
              onClick={() => void sendLayout({ kind: 'focus-panel' })}
            >
              退出独占
            </button>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1">
            <PanelView panelId={focusPanelId} ctx={ctx} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          <LayoutNodeView node={layout.root} ctx={ctx} />
        </div>
      )}
      {panelCount > DEFAULT_DENSITY_PANELS && !densityHintDismissed && (
        <div
          role="note"
          className="absolute left-2 top-2 z-20 flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-1.5 text-xs text-ink shadow-lift"
        >
          <span>
            当前打开 {panelCount} 个 Panel，超出建议密度（1–3
            个）；空间不足时可滚动查看，Panel 不会被压缩到不可用。
          </span>
          <button
            aria-label="关闭密度提示"
            className="rounded px-1 text-muted hover:bg-wash hover:text-ink"
            onClick={() => setDensityHintDismissed(true)}
          >
            ×
          </button>
        </div>
      )}
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

/** Panels beyond this count keep working but earn a non-blocking hint. */
const DEFAULT_DENSITY_PANELS = 3

// ---------------------------------------------------------------------------
// Recursive split-tree rendering
// ---------------------------------------------------------------------------

/** Panel IDs in depth-first tree order — the rendered left-to-right order. */
function treePanelOrder(node: LayoutNode | null): PanelId[] {
  if (!node) return []
  if (node.kind === 'panel') return [node.panelId]
  return [...treePanelOrder(node.first), ...treePanelOrder(node.second)]
}

/**
 * Finds a rendered tab by its raw opaque ID. Never a CSS attribute
 * selector: the contract allows any string ID, and quotes or backslashes
 * would make a naive selector throw (#24 round-2 review).
 */
function findRenderedTab(tabId: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-tab-id]')) {
    if (el.dataset.tabId === tabId) return el
  }
  return null
}

/** Same raw-ID lookup for the per-panel Focus trigger button. */
function findFocusTrigger(panelId: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(
    '[data-focus-trigger]'
  )) {
    if (el.dataset.focusTrigger === panelId) return el
  }
  return null
}

/**
 * Spatial keyboard navigation: resolves which panel an arrow key means by
 * geometry, not tree order. Each leaf's bounds are derived from the split
 * directions and ratios; the neighbour is the closest panel strictly in
 * the arrow's direction (minimal gap on the movement axis), preferring the
 * one sharing the most edge on the orthogonal axis, then the closest
 * centre. E.g. in a 2×2 tree, ArrowRight from the bottom-left panel picks
 * the bottom-right (same row), never the top-right.
 */
interface PanelRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

function leafBounds(
  node: LayoutNode,
  rect: PanelRect,
  out: Array<{ panelId: PanelId; rect: PanelRect }>
): void {
  if (node.kind === 'panel') {
    out.push({ panelId: node.panelId, rect })
    return
  }
  if (node.direction === 'horizontal') {
    const xSplit = rect.x0 + (rect.x1 - rect.x0) * node.ratio
    leafBounds(node.first, { ...rect, x1: xSplit }, out)
    leafBounds(node.second, { ...rect, x0: xSplit }, out)
  } else {
    const ySplit = rect.y0 + (rect.y1 - rect.y0) * node.ratio
    leafBounds(node.first, { ...rect, y1: ySplit }, out)
    leafBounds(node.second, { ...rect, y0: ySplit }, out)
  }
}

function spatialTargetPanel(
  root: LayoutNode | null,
  fromPanelId: PanelId,
  arrow: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
): PanelId | undefined {
  if (!root) return undefined
  const leaves: Array<{ panelId: PanelId; rect: PanelRect }> = []
  leafBounds(root, { x0: 0, y0: 0, x1: 1, y1: 1 }, leaves)
  const from = leaves.find((leaf) => leaf.panelId === fromPanelId)
  if (!from) return undefined

  const horizontal = arrow === 'ArrowLeft' || arrow === 'ArrowRight'
  const forward = arrow === 'ArrowRight' || arrow === 'ArrowDown'
  const EPS = 1e-9
  const fromMain0 = horizontal ? from.rect.x0 : from.rect.y0
  const fromMain1 = horizontal ? from.rect.x1 : from.rect.y1
  const fromCross0 = horizontal ? from.rect.y0 : from.rect.x0
  const fromCross1 = horizontal ? from.rect.y1 : from.rect.x1
  const fromCrossCentre = (fromCross0 + fromCross1) / 2

  let best:
    | { panelId: PanelId; gap: number; overlap: number; centre: number }
    | undefined
  for (const leaf of leaves) {
    if (leaf.panelId === fromPanelId) continue
    const main0 = horizontal ? leaf.rect.x0 : leaf.rect.y0
    const main1 = horizontal ? leaf.rect.x1 : leaf.rect.y1
    const cross0 = horizontal ? leaf.rect.y0 : leaf.rect.x0
    const cross1 = horizontal ? leaf.rect.y1 : leaf.rect.x1
    // Strictly in the arrow's direction (allowing shared boundaries).
    if (forward ? main0 < fromMain1 - EPS : main1 > fromMain0 + EPS) continue
    const gap = forward ? main0 - fromMain1 : fromMain0 - main1
    const overlap = Math.max(
      0,
      Math.min(fromCross1, cross1) - Math.max(fromCross0, cross0)
    )
    const centre = Math.abs((cross0 + cross1) / 2 - fromCrossCentre)
    if (
      !best ||
      gap < best.gap - EPS ||
      (Math.abs(gap - best.gap) <= EPS &&
        (overlap > best.overlap + EPS ||
          (Math.abs(overlap - best.overlap) <= EPS &&
            centre < best.centre - EPS)))
    ) {
      best = { panelId: leaf.panelId, gap, overlap, centre }
    }
  }
  return best?.panelId
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
  // Children keep a minimum usable size (UX-v0.2 §7.2(8)): when the window
  // cannot fit them the split container scrolls instead of compressing
  // panels into an inoperable state.
  const childMin = 'min-w-56 min-h-32'
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 overflow-auto ${
        node.direction === 'horizontal' ? 'flex-row' : 'flex-col'
      }`}
    >
      <div
        className={`flex min-h-0 min-w-0 ${childMin}`}
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
      <div className={`flex min-h-0 min-w-0 flex-1 ${childMin}`}>
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
      className={`group relative shrink-0 ${
        direction === 'horizontal'
          ? 'w-2 cursor-col-resize'
          : 'h-2 cursor-row-resize'
      }`}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={cancelDrag}
      onLostPointerCapture={cancelDrag}
    >
      {/* Frozen-baseline divider (#67): an 8px hit area with a centered 2px
          line that turns brand on hover/focus. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute rounded-full bg-line transition-colors group-hover:bg-brand group-focus-visible:bg-brand ${
          direction === 'horizontal'
            ? 'inset-y-2 left-[3px] w-0.5'
            : 'inset-x-2 top-[3px] h-0.5'
        }`}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel — toolbar, unique Agent Tabs, agent view, drop zones
// ---------------------------------------------------------------------------

/**
 * Keyboard parity for tab gestures (#5): plain arrows and Home/End move
 * DOM focus within the tablist (ARIA manual activation), Ctrl+Arrow moves
 * the tab across panels (the pointer centre drop) and Ctrl+Shift+Arrow
 * split-moves it (the pointer edge drop). Every path normalises to the
 * same layout commands as the pointer equivalent.
 */
function handleTabKeyDown(
  e: KeyboardEvent<HTMLDivElement>,
  ctx: LayoutRenderContext,
  panelId: PanelId,
  tabId: AgentInstanceId
): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    void ctx.sendLayout({
      kind: 'activate-tab',
      panelId,
      agentInstanceId: tabId
    })
    return
  }

  const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
  if (!ARROWS.includes(e.key) && e.key !== 'Home' && e.key !== 'End') return

  const plain =
    !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
  if (e.key === 'Home' || e.key === 'End' || (plain && ARROWS.includes(e.key))) {
    e.preventDefault()
    const tablist = e.currentTarget.closest('[role="tablist"]')
    const tabs = Array.from(
      tablist?.querySelectorAll('[role="tab"]') ?? []
    ) as HTMLElement[]
    const index = tabs.indexOf(e.currentTarget)
    let target: HTMLElement | undefined
    if (e.key === 'ArrowRight') target = tabs[index + 1]
    else if (e.key === 'ArrowLeft') target = tabs[index - 1]
    else if (e.key === 'Home') target = tabs[0]
    else if (e.key === 'End') target = tabs[tabs.length - 1]
    target?.focus()
    return
  }

  // #77: Alt+ArrowLeft/Right reorders the tab within its own panel's strip —
  // the keyboard equivalent of the pointer drag-and-drop reorder (§15).
  if (
    e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.shiftKey &&
    (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
  ) {
    e.preventDefault()
    const tablist = e.currentTarget.closest('[role="tablist"]')
    const tabs = Array.from(
      tablist?.querySelectorAll('[role="tab"]') ?? []
    ) as HTMLElement[]
    const currentIndex = tabs.indexOf(e.currentTarget)
    const targetIndex =
      e.key === 'ArrowLeft' ? currentIndex - 1 : currentIndex + 2
    if (targetIndex < 0 || targetIndex > tabs.length) return
    const reorderIntent = ctx.onRequestTabFocus(tabId)
    void ctx
      .sendLayout({
        kind: 'move-tab',
        agentInstanceId: tabId,
        targetPanelId: panelId,
        insertionIndex: targetIndex
      })
      .then((result) => {
        if (!result.ok) ctx.onCancelTabFocus(reorderIntent)
      })
    return
  }

  if (!(e.ctrlKey || e.metaKey) || e.altKey || !ARROWS.includes(e.key)) return
  e.preventDefault()
  if (e.shiftKey) {
    // Split-move — the same command a drop on the matching edge produces.
    const direction =
      e.key === 'ArrowLeft' || e.key === 'ArrowRight'
        ? 'horizontal'
        : 'vertical'
    const position =
      e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? 'before' : 'after'
    // The tab node is rebuilt in the new panel — refocus it after render.
    const splitMoveIntent = ctx.onRequestTabFocus(tabId)
    void ctx
      .sendLayout({
        kind: 'open-tab-in-new-panel',
        agentInstanceId: tabId,
        direction,
        position,
        relativeToPanelId: panelId
      })
      .then((result) => {
        if (!result.ok) ctx.onCancelTabFocus(splitMoveIntent)
      })
    return
  }
  // Move to the spatial neighbour in the arrow's direction — the same
  // panel a centre drop onto that neighbour would target.
  const target = spatialTargetPanel(
    ctx.project.layout.root,
    panelId,
    e.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
  )
  if (target) {
    // The tab node is rebuilt in the target panel — refocus after render.
    const moveIntent = ctx.onRequestTabFocus(tabId)
    void ctx
      .sendLayout({
        kind: 'move-tab',
        agentInstanceId: tabId,
        targetPanelId: target
      })
      .then((result) => {
        if (!result.ok) ctx.onCancelTabFocus(moveIntent)
      })
  }
}

/**
 * Compute the tab insertion index from the pointer's horizontal position
 * relative to each tab element's centre (#77). Returns null when the drop
 * would be a no-op (the dragged tab dropped where it already is).
 */
function computeTabInsertionIndex(
  tablist: HTMLElement,
  clientX: number,
  tabs: AgentInstanceId[],
  draggedTabId: AgentInstanceId
): number | null {
  const tabEls = Array.from(
    tablist.querySelectorAll('[data-tab-id]')
  ) as HTMLElement[]
  let index = tabEls.length
  for (let i = 0; i < tabEls.length; i++) {
    const rect = tabEls[i].getBoundingClientRect()
    if (clientX < rect.left + rect.width / 2) {
      index = i
      break
    }
  }
  // Suppress the indicator when the drop would leave the tab in place.
  const draggedEl = tabEls.find((el) => el.dataset.tabId === draggedTabId)
  if (draggedEl) {
    const rect = draggedEl.getBoundingClientRect()
    const isBefore = clientX < rect.left + rect.width / 2
    const draggedIndex = tabs.indexOf(draggedTabId)
    if (
      (isBefore && index === draggedIndex) ||
      (!isBefore && index === draggedIndex + 1)
    ) {
      return null
    }
  }
  return index
}

const TAB_KEYSHORTCUTS = [
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Alt+ArrowLeft',
  'Alt+ArrowRight',
  'Control+ArrowLeft',
  'Control+ArrowRight',
  'Control+ArrowUp',
  'Control+ArrowDown',
  'Control+Shift+ArrowLeft',
  'Control+Shift+ArrowRight',
  'Control+Shift+ArrowUp',
  'Control+Shift+ArrowDown'
].join(' ')

// The two split actions differ only in direction, label, and icon (#92
// review) — one definition, mapped at the call site.
const SPLIT_ACTIONS = [
  { direction: 'horizontal', label: '向右分割', icon: '⇆' },
  { direction: 'vertical', label: '向下分割', icon: '⇅' }
] as const

function PanelView({ panelId, ctx }: { panelId: PanelId; ctx: LayoutRenderContext }) {
  const { project, snapshot, openAttentionTargets, sendLayout } = ctx
  const panel = project.layout.panels[panelId]
  if (!panel) return null
  const activeAgent = snapshot.agents.find(
    (a) => a.agentInstanceId === panel.activeTabId
  )
  // Frozen-baseline panel chrome (#67): the P-label follows the rendered
  // tree order, and the focused Panel carries the brand ring so the active
  // target is visible without relying on color alone (the layout focus is
  // also exposed through the Focus toolbar state).
  const panelIndex = treePanelOrder(project.layout.root).indexOf(panelId) + 1
  const isLayoutFocused = project.layout.focusedPanelId === panelId
  // Layout-editing actions are hidden while a temporary Focus is active.
  const canEditLayout = !ctx.temporaryFocusPanelId

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
      className={`pointer-events-auto absolute border border-dashed border-transparent hover:border-brand hover:bg-brand-soft/70 ${className}`}
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
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-paper ${
        isLayoutFocused
          ? 'border-brand shadow-panel-focus'
          : 'border-line shadow-panel'
      }`}
    >
      {/* #92: merged toolbar + tab strip into one visual row. The tablist
          (role=tablist) only contains tabs; layout actions are siblings
          in a separate group to preserve WAI-ARIA semantics. */}
      <div
        className={`relative z-20 flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-raised py-1 pl-1.5 pr-1.5 ${
          ctx.draggingTab && ctx.tabStripInsertion?.panelId === panelId
            ? 'tab-strip-drop-target'
            : ''
        }`}
      >
        <span
          aria-hidden="true"
          className="grid min-w-[28px] shrink-0 place-items-center font-mono text-[10px] font-bold text-muted"
        >
          P{panelIndex}
        </span>
        <div
          role="tablist"
          aria-label="Agent 标签"
          className="flex min-w-[120px] flex-1 items-center gap-0 overflow-x-auto"
          onDragOver={(e) => {
          if (!ctx.draggingTab) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const result = computeTabInsertionIndex(
            e.currentTarget,
            e.clientX,
            panel.tabs,
            ctx.draggingTab.tabId as AgentInstanceId
          )
          ctx.onTabStripInsertion(
            result === null ? null : { panelId, index: result }
          )
        }}
        onDragLeave={(e) => {
          // Only clear if leaving the tablist entirely (not entering a child).
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            if (ctx.tabStripInsertion?.panelId === panelId) {
              ctx.onTabStripInsertion(null)
            }
          }
        }}
        onDrop={(e) => {
          if (!ctx.draggingTab) return
          e.preventDefault()
          e.stopPropagation()
          const tabId = (e.dataTransfer.getData('text/plain') ||
            ctx.draggingTab.tabId) as AgentInstanceId
          const baseline = ctx.draggingTab.startRevision
          const insertion = ctx.tabStripInsertion
          ctx.onDragTabEnd()
          if (tabId && insertion) {
            void sendLayout(
              {
                kind: 'move-tab',
                agentInstanceId: tabId,
                targetPanelId: panelId,
                insertionIndex: insertion.index
              },
              baseline
            )
          }
        }}
      >
        {panel.tabs.map((tabId, tabIndex) => {
          const agent = snapshot.agents.find(
            (a) => a.agentInstanceId === tabId
          )
          if (!agent) return null
          const selected = tabId === panel.activeTabId
          // #77: insertion indicator — a 2px brand line before the tab at
          // the hovered index.
          const showInsertionBefore =
            ctx.tabStripInsertion?.panelId === panelId &&
            ctx.tabStripInsertion.index === tabIndex
          return (
            <div key={tabId} className="flex items-center">
              {showInsertionBefore && (
                <div
                  aria-hidden="true"
                  className="tab-insertion-indicator"
                />
              )}
              <div
                role="tab"
                aria-selected={selected}
                aria-keyshortcuts={TAB_KEYSHORTCUTS}
                data-tab-id={tabId}
                tabIndex={selected ? 0 : -1}
                draggable
                className={`flex min-w-[120px] max-w-[190px] cursor-pointer items-center gap-1.5 border-b-2 border-r border-r-line px-2 py-1.5 text-sm transition-colors ${
                  selected
                    ? 'border-b-brand bg-gradient-to-b from-paper to-brand-soft/40 text-ink'
                    : 'border-b-transparent text-muted hover:bg-wash'
                }`}
                onClick={() =>
                  void sendLayout({
                    kind: 'activate-tab',
                    panelId,
                    agentInstanceId: tabId
                  })
                }
                onKeyDown={(e) => handleTabKeyDown(e, ctx, panelId, tabId)}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', tabId)
                  e.dataTransfer.effectAllowed = 'move'
                  ctx.onDragTabStart(tabId)
                }}
                onDragEnd={ctx.onDragTabEnd}
              >
                {/* Decorative — the adjacent sublabel already names the
                    state, so the accessible name still starts with the
                    Agent Name. */}
                <StatusDot state={statusDotState(agent.runtimeState)} />
                <span className="truncate font-mono">{agent.name}</span>
                {openAttentionTargets.has(tabId) && (
                  <span
                    role="img"
                    aria-label="有待处理事项"
                    className="text-amber"
                  >
                    ●
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-muted">
                  {providerLabel(agent.providerId)} ·{' '}
                  {AGENT_DISPLAY_STATE_LABEL[agentDisplayState(agent.runtimeState)]}
                </span>
                <button
                  aria-label={`关闭标签 ${agent.name}`}
                  className="shrink-0 rounded px-1 text-muted hover:bg-wash hover:text-ink"
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
            </div>
          )
        })}
        {/* Trailing insertion indicator (drop at end of strip). */}
        {ctx.tabStripInsertion?.panelId === panelId &&
          ctx.tabStripInsertion.index >= panel.tabs.length && (
            <div
              aria-hidden="true"
              className="tab-insertion-indicator ml-1"
            />
          )}
        </div>{/* end tablist */}
        {/* #92: layout actions — siblings of the tablist, not inside it. */}
        {canEditLayout && (
          <>
            {SPLIT_ACTIONS.map(({ direction, label, icon }) => (
              <button
                key={direction}
                aria-label={label}
                className="mini-button shrink-0"
                onClick={() =>
                  void sendLayout({
                    kind: 'split-panel',
                    panelId,
                    direction
                  })
                }
              >
                {icon}
              </button>
            ))}
            <button
              className="mini-button shrink-0"
              title="以此 Panel 为主，生成一主两辅布局"
              onClick={() =>
                void sendLayout({ kind: 'apply-analysis-preset', panelId })
              }
            >
              三栏分析
            </button>
          </>
        )}
        {canEditLayout && (
          <button
            aria-label="独占此 Panel"
            data-focus-trigger={panelId}
            className="mini-button shrink-0"
            onClick={() => void sendLayout({ kind: 'focus-panel', panelId })}
          >
            独占
          </button>
        )}
        {canEditLayout && ctx.panelCount > 1 && (
          <button
            aria-label="关闭 Panel"
            className="mini-button shrink-0"
            onClick={() => ctx.onRequestClosePanel(panelId)}
          >
            ✕
          </button>
        )}
      </div>

      {activeAgent ? (
        /* #88: keyed fade-in when switching tabs — reduced-motion is
           handled globally by the base layer transition kill-switch. */
        <div key={activeAgent.agentInstanceId} className="min-h-0 min-w-0 flex-1 animate-[fade-in_140ms_ease-out]">
          <AgentView
            project={project}
            agent={activeAgent}
            snapshot={snapshot}
            planDispatch={ctx.planDispatch}
            sendCommand={ctx.sendCommand}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted">未选择 Agent</p>
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
      className="absolute inset-0 z-10 flex items-center justify-center bg-backdrop"
    >
      <div className="w-80 space-y-3 rounded-xl border border-line bg-paper p-4 shadow-overlay">
        <h3 className="text-sm font-medium text-ink">关闭 Panel</h3>
        <p className="text-xs text-muted">
          该 Panel 仍含有 Agent 标签，关闭前请选择迁移目标；标签只改变视图位置，不影响运行状态。
        </p>
        <label className="block text-xs text-muted">
          迁移目标 Panel
          <select
            aria-label="迁移目标 Panel"
            className="mt-1 w-full rounded border border-line bg-paper px-2 py-1 text-sm text-ink"
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
            className="btn btn-ghost"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="btn btn-primary"
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
  planDispatch,
  sendCommand
}: {
  project: ProjectViewModel
  agent: AgentInstanceViewModel
  snapshot: WorkbenchViewModel
  planDispatch: PlanDispatch
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
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Head card (#67, #88): provider icon + name title, Provider/worktree
          sublabel, and the run state double-coded by dot + text. The state
          pill gets a brand accent when the agent is active. */}
      <header className="flex min-h-[52px] shrink-0 items-center gap-3 border-b border-line bg-gradient-to-r from-wash via-paper to-paper px-3.5">
        <ProviderIcon providerId={agent.providerId} size={32} className="shrink-0" />
        <div className="min-w-0">
          <h3 className="truncate font-mono text-[13px] font-bold text-ink">
            {agent.name}
          </h3>
          <p className="truncate text-[10px] text-muted">
            {providerLabel(agent.providerId)} ·{' '}
            {WORKTREE_MODE_LABEL[agent.worktreeMode]}
          </p>
        </div>
        <span
          className={`ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium ${
            agentDisplayState(agent.runtimeState) === 'completed'
              ? 'bg-teal-soft text-teal'
              : 'bg-wash text-muted'
          }`}
        >
          <StatusDot state={statusDotState(agent.runtimeState)} />
          {AGENT_DISPLAY_STATE_LABEL[agentDisplayState(agent.runtimeState)]}
        </span>
      </header>

      {/* Unavailable (#14): every per-agent sub-view stays read-only; the
          only in-place action navigates to the global Provider Health
          surface — recovery itself remains an explicit action there. */}
      {agent.runtimeState === 'unavailable' && (
        <div
          role="note"
          className="mx-3 mt-2 flex shrink-0 items-center gap-2 rounded-lg bg-amber-soft px-3 py-2 text-xs text-amber"
        >
          <span className="flex-1">
            Provider 不可用；当前仅可查看历史记录，修复 Provider 后可恢复。
          </span>
          <button
            className="mini-button shrink-0"
            onClick={() =>
              void sendCommand({
                kind: 'navigate-global',
                surface: 'provider-health'
              })
            }
          >
            修复 Provider
          </button>
        </div>
      )}

      {/* Underline segmented nav (#67) — the active segment pairs the
          underline with bold text, never color alone. */}
      <div className="flex shrink-0 gap-4 border-b border-line px-3">
        {SUB_VIEWS.map(({ view, label }) => (
          <button
            key={view}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-1 py-1.5 text-xs ${
              subView === view
                ? 'border-ink font-bold text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
            onClick={() => setSubView(view)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Chat pins its composer to the Panel bottom and scrolls the log
          internally; the other sub-views scroll as one block. */}
      <div
        className={
          subView === 'chat'
            ? 'flex min-h-0 flex-1 flex-col overflow-hidden px-3 pt-2 text-sm text-muted'
            : 'min-h-0 flex-1 overflow-auto px-3 py-2 text-sm text-muted'
        }
      >
        {subView === 'chat' && (
          <ChatState
            project={project}
            agent={agent}
            snapshot={snapshot}
            planDispatch={planDispatch}
            sendCommand={sendCommand}
          />
        )}
        {subView === 'activity' &&
          (agentActivity.length === 0 ? (
            <p className="text-muted">暂无活动记录</p>
          ) : (
            <ul className="space-y-1.5">
              {agentActivity.map((entry) => {
                const kindLabel = activityKindLabel(entry.kind)
                return (
                  <li
                    key={entry.activityId}
                    aria-label={`${kindLabel}：${entry.summary}`}
                    className="text-ink"
                  >
                    <span className="mr-1 text-muted">{kindLabel}</span>
                    {entry.summary}
                  </li>
                )
              })}
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
// RichText — lightweight mock markdown rendering (#88)
// ---------------------------------------------------------------------------

/**
 * Minimal markdown subset renderer for the mock conversation content: code
 * fences (```...```), inline code (`...`), **bold**, `- ` list items and
 * `# `/`## ` headings. Kept dependency-free; a full markdown pipeline lands
 * with the real streaming transcripts.
 */
function RichText({ text, onDark = false }: { text: string; onDark?: boolean }) {
  const blocks = text.split(/(```[\s\S]*?```)/g)
  return (
    <div className="space-y-1.5 text-[12px] leading-relaxed">
      {blocks.map((block, i) => {
        if (block.startsWith('```')) {
          const code = block.replace(/^```.*\n/, '').replace(/```$/, '').trimEnd()
          return (
            <pre
              key={i}
              className="overflow-x-auto rounded-lg border border-line bg-wash px-3 py-2 font-mono text-[11px] leading-relaxed text-ink"
            >
              {code}
            </pre>
          )
        }
        const lines = block.split('\n')
        return (
          <div key={i} className="space-y-1">
            {lines.map((line, j) => {
              const trimmed = line.trim()
              if (!trimmed) return null
              if (trimmed.startsWith('- ')) {
                return (
                  <div key={j} className="flex gap-2">
                    <span className="shrink-0 text-brand" aria-hidden="true">
                      •
                    </span>
                    <span className={onDark ? 'text-paper/90' : 'text-ink'}>
                      {renderInline(trimmed.slice(2), onDark)}
                    </span>
                  </div>
                )
              }
              if (/^#{1,3}\s/.test(trimmed)) {
                return (
                  <p
                    key={j}
                    className={`font-semibold ${onDark ? 'text-paper' : 'text-ink'}`}
                  >
                    {renderInline(trimmed.replace(/^#{1,3}\s/, ''), onDark)}
                  </p>
                )
              }
              return (
                <p key={j} className={onDark ? 'text-paper/90' : 'text-ink'}>
                  {renderInline(trimmed, onDark)}
                </p>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/** Inline **bold** and `code` within a single line. */
function renderInline(text: string, onDark: boolean): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className={onDark ? 'font-semibold text-paper' : 'font-semibold text-ink'}>
          {part.slice(2, -2)}
        </strong>
      )
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={i}
          className={`rounded bg-wash px-1 py-0.5 font-mono text-[11px] ${
            onDark ? 'bg-paper/20 text-paper' : 'text-brand-ink'
          }`}
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    return <span key={i}>{part}</span>
  })
}

/** Tool call rendered as a status card (#88). */
function ToolCallCard({ text, pending }: { text: string; pending?: boolean }) {
  // Categorise the mock tool line by its leading verb for the icon glyph.
  const icon = /^(Bash|Terminal|npm|npx|pip)/.test(text)
    ? '⚙'
    : /^(Read|Write|Edit|Open|Create)/.test(text)
      ? '✎'
      : /^(Search|Grep|Find|Query)/.test(text)
        ? '⌕'
        : '⚡'
  return (
    <div className="mb-3 flex max-w-[72ch] items-center gap-2.5 rounded-xl border border-line bg-wash px-3 py-2">
      <span aria-hidden="true" className="shrink-0 text-[13px]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
        {text}
      </span>
      <StatusDot
        state={pending ? 'running' : 'ready'}
        label={pending ? '工具运行中' : '工具已完成'}
      />
      <span className="shrink-0 text-[10px] text-muted">
        {pending ? '运行中' : '已完成'}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chat sub-view — state text driven only by port-judged facts (#20)
// ---------------------------------------------------------------------------

function ChatState({
  project,
  agent,
  snapshot,
  planDispatch,
  sendCommand
}: {
  project: ProjectViewModel
  agent: AgentInstanceViewModel
  snapshot: WorkbenchViewModel
  planDispatch: PlanDispatch
  sendCommand: SendCommand
}) {
  // #88: eyebrow label above each conversation block.
  const speakerLabelClass =
    'mb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-muted'
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const [sendMode, setSendMode] = useState<'reply' | 'enqueue'>('reply')

  const lifecycleBlocked =
    agent.runtimeState === 'unavailable' || agent.runtimeState === 'archived'
  const projectBlockReason = getProjectDispatchBlockReason(project)
  const projectBlocked = projectBlockReason !== undefined
  // ADR-0007: structured Run and Terminal PTY are mutually exclusive. While
  // Terminal is opening or active the composer is disabled and shows why.
  const terminalBlocked = isTerminalExecutionSlotOccupied(agent.terminalState)
  const baseDisabled =
    projectBlocked || lifecycleBlocked || terminalBlocked || submitting
  const awaitingInput = agent.runtimeState === 'needs-input'
  const replyingToCurrentRun = awaitingInput && sendMode === 'reply'
  const {
    plan: currentPlan,
    planning,
    error: planError,
    retry: retryPlan
  } = useDispatchPlan({
    planDispatch,
    revision: snapshot.revision,
    projectId: project.projectId,
    targetIds: [agent.agentInstanceId],
    enabled:
      !projectBlocked &&
      !lifecycleBlocked &&
      !terminalBlocked &&
      !replyingToCurrentRun
  })
  const planEntry = currentPlan?.entries[0]

  // This Agent's adapter-owned conversation entries (#67), oldest first.
  const chatEntries = snapshot.chatEntries.filter(
    (entry) => entry.agentInstanceId === agent.agentInstanceId
  )

  const disabled =
    baseDisabled || (!replyingToCurrentRun && (planning || !currentPlan))

  const submit = async () => {
    const instruction = draft.trim()
    if (!instruction || disabled || submittingRef.current) return
    const mode = replyingToCurrentRun
      ? 'reply-current-run'
      : 'start-or-queue'
    const expectedRevision = replyingToCurrentRun
      ? snapshot.revision
      : currentPlan!.revision
    submittingRef.current = true
    setSubmitting(true)
    setNotice(null)
    try {
      const result = await sendCommand(
        {
          kind: 'send-agent-instruction',
          projectId: project.projectId,
          agentInstanceId: agent.agentInstanceId,
          instruction,
          // UX-v0.2 §6.3: only an explicitly needs-input Run may be replied
          // to. Every start-or-queue instruction is bound to its preview.
          mode
        },
        expectedRevision
      )
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
      {/* #78: read-only archive notice bar with a reopen action. The bar
          pairs a text label with a border accent so the archived state is
          recognisable without relying on color alone (§15). */}
      {agent.runtimeState === 'archived' && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-3 border-b-2 border-brand border-l-4 border-l-brand bg-brand-soft px-3 py-2"
        >
          <span className="text-xs font-semibold text-brand-ink">
            🔒 已归档 — 只读视图：完整对话与 Run 记录仍可查看，不可发送新指令。
          </span>
          <button
            className="btn btn-primary min-h-[28px]"
            onClick={() =>
              void sendCommand({
                kind: 'restore-instance',
                projectId: project.projectId,
                agentInstanceId: agent.agentInstanceId
              })
            }
          >
            重开实例
          </button>
        </div>
      )}
      <div
        role="log"
        aria-label="对话记录"
        aria-busy={planning}
        className="min-h-0 flex-1 overflow-auto"
      >
        {/* Conversation content (#67): the 当前任务 context block and the
            adapter-owned entries (assistant turns, mono tool chips). The
            state-driven status copy below is unchanged — it answers what
            sending NOW would do. */}
        {agent.currentTaskSummary && (
          <article className="mb-3 max-w-[72ch] rounded-xl border border-brand-border bg-brand-soft/50 px-4 py-3">
            <div className={speakerLabelClass}>当前任务</div>
            <RichText text={agent.currentTaskSummary} />
          </article>
        )}
        {chatEntries.map((entry) =>
          entry.kind === 'tool' ? (
            <ToolCallCard
              key={entry.entryId}
              text={entry.text}
              pending={entry.pending}
            />
          ) : (
            <article
              key={entry.entryId}
              className={`enter-up mb-3 max-w-[72ch] ${
                entry.kind === 'user'
                  ? 'ml-auto rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-paper shadow-sm'
                  : 'rounded-2xl rounded-bl-md bg-paper px-4 py-2.5 shadow-card'
              }`}
            >
              <div
                className={`mb-1 text-[10px] font-bold uppercase tracking-[0.08em] ${
                  entry.kind === 'user' ? 'text-paper/75' : 'text-muted'
                }`}
              >
                {entry.kind === 'user' ? '用户' : agent.name}
              </div>
              <RichText text={entry.text} onDark={entry.kind === 'user'} />
            </article>
          )
        )}
        {projectBlockReason === 'project-archived' ? (
          <p className="text-muted">
            Project 已归档；仅可查看历史记录，不能发送新指令。
          </p>
        ) : projectBlockReason === 'project-root-unavailable' ? (
          <p className="text-muted">
            Project Root 不可用；仅可查看历史记录，请先恢复或重新定位 Root。
          </p>
        ) : projectBlockReason === 'project-repository-not-ready' ? (
          <p className="text-muted">
            Project 尚未初始化或绑定 Git 仓库；仅可查看历史记录，请先完成 Git
            初始化或绑定。
          </p>
        ) : agent.runtimeState === 'unavailable' ? (
          <p className="text-muted">
            Provider 不可用；当前仅可查看历史记录，修复 Provider 后可恢复。
          </p>
        ) : agent.runtimeState === 'archived' ? (
          <p className="text-muted">
            Agent 已归档；仅可查看历史记录，不能发送新指令。
          </p>
        ) : terminalBlocked ? (
          <p className="text-muted">
            {agent.terminalState === 'opening'
              ? 'Terminal 正在打开或接管中；结构化 Run 与 PTY 互斥，请等待打开完成并结束接管。'
              : 'Terminal 接管中；结构化 Run 与 PTY 互斥，请先结束接管再发送指令。'}
          </p>
        ) : awaitingInput ? (
          <fieldset className="space-y-1">
            <legend className="text-muted">
              当前 Run 正在等待输入。选择回复当前 Run 或加入下一 Run 队列。
            </legend>
            <div className="flex gap-3 text-xs">
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name={`send-mode-${agent.agentInstanceId}`}
                  checked={sendMode === 'reply'}
                  onChange={() => setSendMode('reply')}
                />
                回复当前 Run
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name={`send-mode-${agent.agentInstanceId}`}
                  checked={sendMode === 'enqueue'}
                  onChange={() => setSendMode('enqueue')}
                />
                加入下一队列
              </label>
            </div>
            {sendMode === 'enqueue' && (
              <p className="text-muted">
                {planEntry?.outcome === 'queue'
                  ? `加入下一 Run 将进入第 ${planEntry.position} 位。`
                  : planEntry?.outcome === 'start'
                    ? '下一 Run 可立即启动。'
                    : '正在计算下一 Run 队位…'}
              </p>
            )}
          </fieldset>
        ) : planEntry?.outcome === 'queue' ? (
          /* Queue hint as the light info bar (#67) — position facts stay
             planner-owned, only the presentation changed. */
          <p className="rounded-lg border border-brand-border bg-brand-soft px-3 py-2 text-xs text-brand-ink">
            当前 Project 已有 {planEntry.position - 1}{' '}
            项排队；新指令将进入第 {planEntry.position} 位。
          </p>
        ) : planning ? (
          <p className="text-muted">
            正在计算新指令的启动与队位…
          </p>
        ) : planError ? (
          <p className="text-muted">
            暂时无法计算新指令的启动与队位。
          </p>
        ) : (
          chatEntries.length === 0 && (
            <p className="text-muted">
              暂无对话记录；发送首条消息后才会启动 Run。
            </p>
          )
        )}
      </div>

      {notice && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {notice}
        </p>
      )}

      {planError && (
        <div
          role="alert"
          className="mt-2 flex items-center gap-2 text-xs text-danger"
        >
          <span>{planError}</span>
          <button
            className="rounded px-2 py-1 text-ink hover:bg-wash"
            disabled={submitting}
            onClick={retryPlan}
          >
            重新计算
          </button>
        </div>
      )}

      {/* Per-Panel composer (#67): placeholder and accessible name carry
          the target Agent Name so the single-target semantics stay
          explicit; the round brand-primary button starts or continues the
          current Run only — never a broadcast. */}
      <div className="mt-2 flex shrink-0 items-end gap-2 border-t border-line pt-2">
        <textarea
          aria-label={`发送给 ${agent.name}`}
          placeholder={`只发送给 ${agent.name}…`}
          className="max-h-[74px] min-h-9 flex-1 resize-none rounded-lg border border-line bg-paper px-2.5 py-2 text-xs text-ink placeholder:text-muted"
          value={draft}
          disabled={baseDisabled}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          aria-label={`发送给 ${agent.name}`}
          title="显式启动或继续当前 Run；不会发送给其他 Agent"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand text-sm text-paper transition-colors not-disabled:hover:bg-brand-ink disabled:opacity-45"
          disabled={disabled || draft.trim().length === 0}
          onClick={() => void submit()}
        >
          ↑
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
    return <p className="text-muted">暂无改动</p>
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
              ? 'text-amber'
              : 'text-teal'
          }
        >
          {agentChanges.drift === 'behind'
            ? '需要 rebase：base commit 已落后'
            : 'Base 同步'}
        </span>
        <span
          className={
            agentChanges.validation.status === 'fail'
              ? 'text-danger'
              : agentChanges.validation.status === 'pass'
                ? 'text-teal'
                : 'text-muted'
          }
        >
          验证：{agentChanges.validation.status === 'pass'
            ? '通过'
            : agentChanges.validation.status === 'fail'
              ? `失败${agentChanges.validation.message ? '（' + agentChanges.validation.message + '）' : ''}`
              : '等待中'}
        </span>
        <span className="text-muted">
          base: {agentChanges.baseCommit}
        </span>
      </div>

      {/* Needs rebase notice */}
      {agentChanges.drift === 'behind' && (
        <div className="rounded-lg bg-amber-soft px-3 py-2 text-xs text-amber">
          主仓库已超前于本 worktree 的 base commit。请先更新 worktree、解冲突并重新验证，再尝试合并。不提供自动 rebase、冲突解决或 force merge。
        </div>
      )}

      {/* File list */}
      <ul className="space-y-1 font-mono text-xs">
        {agentChanges.files.map((file) => (
          <li key={file.path} className="flex items-center gap-2">
            <span className="w-8 text-muted">
              {FILE_STATUS_LABEL[file.status] ?? file.status}
            </span>
            <span className="flex-1 text-ink">{file.path}</span>
            <span className="text-teal">+{file.additions}</span>
            <span className="text-danger">-{file.deletions}</span>
          </li>
        ))}
      </ul>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          className="btn btn-primary"
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
          className="btn btn-danger"
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

const TERMINAL_PROJECT_BLOCK_COPY: Record<
  ProjectDispatchBlockReason,
  { title: string; description: string }
> = {
  'project-archived': {
    title: 'Project 已归档',
    description:
      'Project 已归档，不能打开 Terminal。可在 Project 设置查看当前生命周期状态。'
  },
  'project-root-unavailable': {
    title: 'Project Root 不可用',
    description:
      'Project Root 不可用，不能打开 Terminal。可在 Project 设置查看 Root 可用性。'
  },
  'project-repository-not-ready': {
    title: 'Project 尚未初始化或绑定 Git 仓库',
    description:
      'Project 尚未初始化或绑定 Git 仓库，不能打开 Terminal。可在 Project 设置查看 Git 就绪状态。'
  }
}

type TerminalOperation = 'open' | 'close'

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
  const [notice, setNotice] = useState<{
    message: string
    operation: TerminalOperation
  } | null>(null)
  const [pendingOperation, setPendingOperation] =
    useState<TerminalOperation | null>(null)
  const submittingRef = useRef(false)
  const focusAfterOperationRef = useRef<TerminalOperation | null>(null)
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const recoveryButtonRef = useRef<HTMLButtonElement>(null)
  const runBlocks = isActiveStructuredRunState(agent.runtimeState)
  const unavailable =
    agent.runtimeState === 'unavailable' || agent.runtimeState === 'archived'
  const projectBlockReason = getProjectDispatchBlockReason(project)
  const projectBlock = projectBlockReason
    ? TERMINAL_PROJECT_BLOCK_COPY[projectBlockReason]
    : undefined
  const submitting = pendingOperation !== null
  const canOpen =
    !isTakeover &&
    !isOpening &&
    !runBlocks &&
    !unavailable &&
    !projectBlock &&
    !submitting

  useEffect(() => {
    const operation = focusAfterOperationRef.current
    if (!operation || submitting) return
    if (operation === 'open' && isTakeover) {
      closeButtonRef.current?.focus()
      focusAfterOperationRef.current = null
      return
    }
    if (operation === 'close' && !isTakeover && !isOpening) {
      if (projectBlock) recoveryButtonRef.current?.focus()
      else openButtonRef.current?.focus()
      focusAfterOperationRef.current = null
    }
  }, [isOpening, isTakeover, projectBlock, submitting])

  const changeTerminalState = async (operation: TerminalOperation) => {
    if (submittingRef.current) return
    submittingRef.current = true
    focusAfterOperationRef.current = operation
    setPendingOperation(operation)
    setNotice(null)
    try {
      const result = await sendCommand({
        kind: 'set-terminal-takeover',
        projectId: project.projectId,
        agentInstanceId: agent.agentInstanceId,
        operation
      })
      if (!result.ok && result.reason !== 'stale-revision') {
        focusAfterOperationRef.current = null
        setNotice({ message: result.message, operation })
      } else if (!result.ok) {
        focusAfterOperationRef.current = null
      }
    } catch {
      focusAfterOperationRef.current = null
      setNotice({ message: 'Terminal 操作失败，请重试。', operation })
    } finally {
      submittingRef.current = false
      setPendingOperation(null)
    }
  }

  const statusText = isTakeover
    ? 'Terminal 已接管'
    : isOpening
      ? 'Terminal 正在打开'
      : isFailed
        ? 'Terminal 打开失败'
        : 'Terminal 未接管'

  const terminalDescription = (): string => {
    if (isTakeover) {
      return '执行槽被 Terminal 占用，结构化 Run 被阻止。关闭 Tab 不会释放执行槽，需显式结束接管。'
    }
    if (isOpening) return '正在初始化 Terminal…'
    if (projectBlock) return projectBlock.description
    if (isFailed) return '上次打开 Terminal 失败。可以重试或保持关闭。'
    if (runBlocks) return 'Agent 正在运行结构化 Run，不能接管 Terminal。'
    if (unavailable) return 'Agent 当前不可用，不能接管 Terminal。'
    return '打开 Terminal 将占用执行槽并阻止结构化 Run。'
  }

  const terminalOpenTitle = (): string | undefined => {
    if (submitting) return 'Terminal 操作处理中'
    if (projectBlock) return projectBlock.title
    if (runBlocks) return 'Agent 正在运行'
    if (unavailable) return 'Agent 不可用'
    return undefined
  }

  const terminalCloseLabel = (): string => {
    if (notice?.operation === 'close') {
      return isTakeover ? '重试结束 Terminal 接管' : '重试清除失败'
    }
    return isTakeover ? '结束接管' : '清除失败'
  }

  return (
    <div className="space-y-2">
      <p
        role="status"
        aria-label="Terminal 状态"
        aria-live="polite"
        className="text-muted"
      >
        {pendingOperation === 'open'
          ? '正在打开 Terminal…'
          : pendingOperation === 'close'
            ? '正在结束 Terminal 接管…'
            : statusText}
      </p>
      <p className="text-xs text-muted">{terminalDescription()}</p>
      {notice && (
        <p role="alert" className="text-xs text-danger">
          {notice.message}
        </p>
      )}
      <div
        role="group"
        aria-label="Terminal 控制"
        aria-busy={submitting}
        className="flex flex-wrap gap-2"
      >
        {projectBlock && (
          <button
            ref={recoveryButtonRef}
            className="mini-button"
            disabled={submitting}
            onClick={() =>
              void sendCommand({
                kind: 'navigate',
                projectId: project.projectId,
                surface: 'settings'
              })
            }
          >
            查看 Project 设置
          </button>
        )}
        {(isTakeover || isFailed) && (
          <button
            ref={closeButtonRef}
            className="mini-button mini-button-danger"
            disabled={submitting}
            onClick={() => void changeTerminalState('close')}
          >
            {terminalCloseLabel()}
          </button>
        )}
        {!isTakeover && !isOpening && (
          <button
            ref={openButtonRef}
            className="mini-button mini-button-primary disabled:cursor-not-allowed"
            disabled={!canOpen}
            title={terminalOpenTitle()}
            onClick={() => void changeTerminalState('open')}
          >
            {notice?.operation === 'open'
              ? '重试打开 Terminal'
              : '打开 Terminal'}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Queue Panel — visible queue depth, reorder, priority, cancel (#7)
// ---------------------------------------------------------------------------

const PRIORITY_LABEL: Record<QueuePriority, string> = {
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
  const cancellations = snapshot.activity
    .filter(
      (entry) =>
        entry.projectId === project.projectId &&
        entry.kind === 'queue-cancelled'
    )
    .sort((a, b) => b.timestamp - a.timestamp)
  const latestCancellation = cancellations[0]

  if (queueItems.length === 0 && !latestCancellation) return null

  const manage = (
    queueItemId: QueueItemId,
    operation:
      | 'cancel'
      | 'move-earlier'
      | 'move-later'
      | 'raise-priority'
      | 'lower-priority'
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
      className="mt-3 space-y-1.5 border-t border-line pt-2"
    >
      <div className="text-xs text-muted">
        队列深度：{queueItems.length}
      </div>
      {queueItems.map((item) => {
        const agentName =
          snapshot.agents.find(
            (a) => a.agentInstanceId === item.agentInstanceId
          )?.name ?? item.agentInstanceId
        const canRaise =
          stepQueuePriority(item.priority, 'raise-priority') !== undefined
        const canLower =
          stepQueuePriority(item.priority, 'lower-priority') !== undefined
        return (
          <div
            key={item.queueItemId}
            role="group"
            aria-label={`队列项 ${item.position}：${agentName}`}
            className="flex items-center gap-2 rounded border border-line bg-paper px-2 py-1 text-xs"
          >
            <span className="w-5 shrink-0 text-muted">{item.position}</span>
            <span className="min-w-0 flex-1 truncate text-ink">
              {agentName}
            </span>
            <span className="shrink-0 text-muted">
              {PRIORITY_LABEL[item.priority] ?? item.priority}
            </span>
            <button
              aria-label="上移"
              className="shrink-0 text-muted hover:text-ink disabled:opacity-20"
              disabled={item.position <= 1}
              onClick={() => manage(item.queueItemId, 'move-earlier')}
            >
              ↑
            </button>
            <button
              aria-label="下移"
              className="shrink-0 text-muted hover:text-ink disabled:opacity-20"
              disabled={item.position >= queueItems.length}
              onClick={() => manage(item.queueItemId, 'move-later')}
            >
              ↓
            </button>
            <button
              aria-label={
                canRaise ? '提高优先级' : '提高优先级（已是最高优先级）'
              }
              className="shrink-0 text-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-20"
              disabled={!canRaise}
              onClick={() => manage(item.queueItemId, 'raise-priority')}
            >
              ⬆
            </button>
            <button
              aria-label={
                canLower ? '降低优先级' : '降低优先级（已是最低优先级）'
              }
              className="shrink-0 text-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-20"
              disabled={!canLower}
              onClick={() => manage(item.queueItemId, 'lower-priority')}
            >
              ⬇
            </button>
            <button
              aria-label="取消排队"
              className="shrink-0 whitespace-nowrap text-danger hover:underline"
              onClick={() => manage(item.queueItemId, 'cancel')}
            >
              取消排队
            </button>
          </div>
        )
      })}
      <p
        role={latestCancellation ? 'status' : undefined}
        aria-label="队列取消结果"
        aria-live="polite"
        aria-atomic="true"
        className="text-xs text-muted"
      >
        {latestCancellation && (
          <>
            {latestCancellation.summary}
            <span className="sr-only">；第 {cancellations.length} 条取消记录</span>
          </>
        )}
      </p>
    </div>
  )
}
