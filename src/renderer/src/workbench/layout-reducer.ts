import type {
  AgentInstanceId,
  CommandRejectionReason,
  LayoutNode,
  LayoutOperation,
  PanelId,
  SplitNodeId,
  WorkspaceLayoutViewModel
} from './contract'

/**
 * The ONE shared layout reducer.
 *
 * It is the single structural layout transition behind the WorkbenchPort:
 * the mock adapter (and later the real main-side adapter) delegates every
 * `change-layout` command here. The renderer must never keep a second copy
 * of these rules. The reducer is pure — it never mutates its input and
 * knows nothing about agents, runtime, PTY or Git; it only sees IDs.
 */

export interface LayoutIdGenerator {
  newPanelId(): PanelId
  newSplitNodeId(): SplitNodeId
}

export type LayoutResult =
  | { ok: true; layout: WorkspaceLayoutViewModel }
  | { ok: false; reason: CommandRejectionReason; message: string }

const MIN_RATIO = 0.1
const MAX_RATIO = 0.9

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

// ---------------------------------------------------------------------------
// Tree helpers (all non-mutating)
// ---------------------------------------------------------------------------

function collectPanelIds(node: LayoutNode | null): PanelId[] {
  if (!node) return []
  if (node.kind === 'panel') return [node.panelId]
  return [...collectPanelIds(node.first), ...collectPanelIds(node.second)]
}

/** Replaces the leaf node for `panelId` with `replacement`, returning a new tree. */
function replacePanelNode(
  node: LayoutNode,
  panelId: PanelId,
  replacement: LayoutNode
): LayoutNode {
  if (node.kind === 'panel') {
    return node.panelId === panelId ? replacement : node
  }
  return {
    ...node,
    first: replacePanelNode(node.first, panelId, replacement),
    second: replacePanelNode(node.second, panelId, replacement)
  }
}

/** Removes the leaf for `panelId`, collapsing parent splits. Returns null when the tree is empty. */
function removePanelNode(node: LayoutNode, panelId: PanelId): LayoutNode | null {
  if (node.kind === 'panel') {
    return node.panelId === panelId ? null : node
  }
  const first = removePanelNode(node.first, panelId)
  const second = removePanelNode(node.second, panelId)
  if (!first) return second
  if (!second) return first
  return { ...node, first, second }
}

function findSplitNode(node: LayoutNode | null, splitNodeId: SplitNodeId): boolean {
  if (!node) return false
  if (node.kind === 'panel') return false
  if (node.splitNodeId === splitNodeId) return true
  return findSplitNode(node.first, splitNodeId) || findSplitNode(node.second, splitNodeId)
}

function resizeSplitNode(
  node: LayoutNode,
  splitNodeId: SplitNodeId,
  ratio: number
): LayoutNode {
  if (node.kind === 'panel') return node
  const next: LayoutNode = {
    ...node,
    first: resizeSplitNode(node.first, splitNodeId, ratio),
    second: resizeSplitNode(node.second, splitNodeId, ratio)
  }
  return next.kind === 'split' && next.splitNodeId === splitNodeId
    ? { ...next, ratio }
    : next
}

// ---------------------------------------------------------------------------
// State helpers on a fresh clone
// ---------------------------------------------------------------------------

function cloneLayout(layout: WorkspaceLayoutViewModel): WorkspaceLayoutViewModel {
  const panels = {} as WorkspaceLayoutViewModel['panels']
  for (const [key, panel] of Object.entries(layout.panels)) {
    panels[key as PanelId] = {
      tabs: [...panel.tabs],
      ...(panel.activeTabId ? { activeTabId: panel.activeTabId } : {})
    }
  }
  return {
    root: layout.root ? structuredClone(layout.root) : null,
    panels,
    ...(layout.focusedPanelId ? { focusedPanelId: layout.focusedPanelId } : {}),
    ...(layout.temporaryFocusPanelId
      ? { temporaryFocusPanelId: layout.temporaryFocusPanelId }
      : {})
  }
}

/** Removes a panel record and its tree leaf; repairs the focused panel. */
function prunePanel(state: WorkspaceLayoutViewModel, panelId: PanelId): void {
  delete state.panels[panelId]
  state.root = state.root ? removePanelNode(state.root, panelId) : null
  if (state.focusedPanelId === panelId) {
    state.focusedPanelId = (Object.keys(state.panels)[0] as PanelId) ?? undefined
    if (!state.focusedPanelId) delete state.focusedPanelId
  }
}

function removeTabFromPanel(
  state: WorkspaceLayoutViewModel,
  panelId: PanelId,
  agentInstanceId: AgentInstanceId
): void {
  const panel = state.panels[panelId]
  panel.tabs = panel.tabs.filter((t) => t !== agentInstanceId)
  if (panel.activeTabId === agentInstanceId) {
    panel.activeTabId = panel.tabs[panel.tabs.length - 1]
    if (!panel.activeTabId) delete panel.activeTabId
  }
}

function findTabOwner(
  state: WorkspaceLayoutViewModel,
  agentInstanceId: AgentInstanceId
): PanelId | undefined {
  return Object.keys(state.panels).find((key) =>
    state.panels[key as PanelId].tabs.includes(agentInstanceId)
  ) as PanelId | undefined
}

function ok(layout: WorkspaceLayoutViewModel): LayoutResult {
  return { ok: true, layout }
}

function reject(reason: CommandRejectionReason, message: string): LayoutResult {
  return { ok: false, reason, message }
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export function applyLayoutOperation(
  layout: WorkspaceLayoutViewModel,
  operation: LayoutOperation,
  ids: LayoutIdGenerator
): LayoutResult {
  switch (operation.kind) {
    case 'open-tab': {
      const state = cloneLayout(layout)
      if (Object.keys(state.panels).length === 0) {
        // Empty workspace: allocate the first panel instead of rejecting.
        const panelId = ids.newPanelId()
        state.panels[panelId] = {
          tabs: [operation.agentInstanceId],
          activeTabId: operation.agentInstanceId
        }
        state.root = { kind: 'panel', panelId }
        state.focusedPanelId = panelId
        return ok(state)
      }
      if (!state.panels[operation.panelId]) {
        return reject('invalid-target', 'Panel 不存在')
      }
      const owner = findTabOwner(state, operation.agentInstanceId)
      if (owner) {
        state.panels[owner].activeTabId = operation.agentInstanceId
        state.focusedPanelId = owner
        return ok(state)
      }
      state.panels[operation.panelId].tabs.push(operation.agentInstanceId)
      state.panels[operation.panelId].activeTabId = operation.agentInstanceId
      state.focusedPanelId = operation.panelId
      return ok(state)
    }

    case 'activate-tab': {
      const panel = layout.panels[operation.panelId]
      if (!panel || !panel.tabs.includes(operation.agentInstanceId)) {
        return reject('invalid-target', 'Tab 不存在')
      }
      const state = cloneLayout(layout)
      state.panels[operation.panelId].activeTabId = operation.agentInstanceId
      state.focusedPanelId = operation.panelId
      return ok(state)
    }

    case 'close-tab': {
      const panel = layout.panels[operation.panelId]
      if (!panel || !panel.tabs.includes(operation.agentInstanceId)) {
        return reject('invalid-target', 'Tab 不存在')
      }
      const state = cloneLayout(layout)
      removeTabFromPanel(state, operation.panelId, operation.agentInstanceId)
      if (state.panels[operation.panelId].tabs.length === 0) {
        prunePanel(state, operation.panelId)
      }
      return ok(state)
    }

    case 'move-tab': {
      if (!layout.panels[operation.targetPanelId]) {
        return reject('invalid-target', '目标 Panel 不存在')
      }
      const owner = findTabOwner(layout, operation.agentInstanceId)
      if (!owner) {
        return reject('invalid-target', 'Tab 不存在')
      }
      const state = cloneLayout(layout)
      if (owner === operation.targetPanelId) {
        state.panels[owner].activeTabId = operation.agentInstanceId
        state.focusedPanelId = owner
        return ok(state)
      }
      removeTabFromPanel(state, owner, operation.agentInstanceId)
      state.panels[operation.targetPanelId].tabs.push(operation.agentInstanceId)
      state.panels[operation.targetPanelId].activeTabId =
        operation.agentInstanceId
      state.focusedPanelId = operation.targetPanelId
      if (state.panels[owner].tabs.length === 0) {
        prunePanel(state, owner)
      }
      return ok(state)
    }

    case 'split-panel': {
      if (!layout.panels[operation.panelId]) {
        return reject('invalid-target', 'Panel 不存在')
      }
      const state = cloneLayout(layout)
      const newPanelId = ids.newPanelId()
      state.panels[newPanelId] = { tabs: [] }
      const splitNodeId = ids.newSplitNodeId()
      const original: LayoutNode = { kind: 'panel', panelId: operation.panelId }
      state.root = replacePanelNode(state.root!, operation.panelId, {
        kind: 'split',
        splitNodeId,
        direction: operation.direction,
        ratio: 0.5,
        first: original,
        second: { kind: 'panel', panelId: newPanelId }
      })
      return ok(state)
    }

    case 'open-tab-in-new-panel': {
      const state = cloneLayout(layout)
      if (Object.keys(state.panels).length === 0) {
        const panelId = ids.newPanelId()
        state.panels[panelId] = {
          tabs: [operation.agentInstanceId],
          activeTabId: operation.agentInstanceId
        }
        state.root = { kind: 'panel', panelId }
        state.focusedPanelId = panelId
        return ok(state)
      }
      const base =
        operation.relativeToPanelId ??
        state.focusedPanelId ??
        (Object.keys(state.panels)[0] as PanelId)
      if (!state.panels[base]) {
        return reject('invalid-target', 'Panel 不存在')
      }
      const newPanelId = ids.newPanelId()
      const splitNodeId = ids.newSplitNodeId()
      const baseNode: LayoutNode = { kind: 'panel', panelId: base }
      const newNode: LayoutNode = { kind: 'panel', panelId: newPanelId }
      state.panels[newPanelId] = {
        tabs: [operation.agentInstanceId],
        activeTabId: operation.agentInstanceId
      }
      state.root = replacePanelNode(state.root!, base, {
        kind: 'split',
        splitNodeId,
        direction: operation.direction,
        ratio: 0.5,
        first: operation.position === 'before' ? newNode : baseNode,
        second: operation.position === 'before' ? baseNode : newNode
      })
      // Move semantics: a tab already open elsewhere leaves its old panel —
      // never a copy. An emptied former owner (other than the split base)
      // is pruned; the base itself may intentionally stay empty.
      const owner = findTabOwner(state, operation.agentInstanceId)
      if (owner && owner !== newPanelId) {
        removeTabFromPanel(state, owner, operation.agentInstanceId)
        if (owner !== base && state.panels[owner].tabs.length === 0) {
          prunePanel(state, owner)
        }
      }
      state.focusedPanelId = newPanelId
      return ok(state)
    }

    case 'close-panel': {
      const panel = layout.panels[operation.panelId]
      if (!panel) {
        return reject('invalid-target', 'Panel 不存在')
      }
      if (panel.tabs.length > 0) {
        if (!operation.migrateToPanelId) {
          return reject(
            'invariant-violation',
            '关闭含 Tab 的 Panel 前必须选择迁移目标'
          )
        }
        if (
          operation.migrateToPanelId === operation.panelId ||
          !layout.panels[operation.migrateToPanelId]
        ) {
          return reject('invalid-target', '迁移目标 Panel 不存在')
        }
      }
      const state = cloneLayout(layout)
      if (panel.tabs.length > 0 && operation.migrateToPanelId) {
        const target = state.panels[operation.migrateToPanelId]
        target.tabs.push(...panel.tabs)
        target.activeTabId = panel.tabs[0]
        state.focusedPanelId = operation.migrateToPanelId
      }
      prunePanel(state, operation.panelId)
      return ok(state)
    }

    case 'resize-split': {
      if (!findSplitNode(layout.root, operation.splitNodeId)) {
        return reject('invalid-target', '分割节点不存在')
      }
      const state = cloneLayout(layout)
      state.root = resizeSplitNode(
        state.root!,
        operation.splitNodeId,
        clampRatio(operation.ratio)
      )
      return ok(state)
    }

    case 'prune-empty-panels': {
      const state = cloneLayout(layout)
      for (const key of Object.keys(state.panels)) {
        const panelId = key as PanelId
        if (state.panels[panelId].tabs.length === 0) {
          prunePanel(state, panelId)
        }
      }
      return ok(state)
    }

    default:
      // focus-panel belongs to the advanced layout ticket (#5).
      return reject('scenario-read-only', '此布局操作尚未实现')
  }
}

// ---------------------------------------------------------------------------
// Invariants (shared by property tests and adapters)
// ---------------------------------------------------------------------------

/**
 * Throws when the layout violates a structural invariant. Used by property
 * tests after every operation; adapters may use it as a debug guard.
 */
export function assertLayoutInvariants(layout: WorkspaceLayoutViewModel): void {
  const treePanels = collectPanelIds(layout.root)
  const recordPanels = Object.keys(layout.panels) as PanelId[]

  // Tree leaves and the panels record describe exactly the same panels,
  // and no panel appears twice in the tree.
  const duplicateLeaves = treePanels.filter(
    (p, i) => treePanels.indexOf(p) !== i
  )
  if (duplicateLeaves.length > 0) {
    throw new Error(`panel appears twice in tree: [${duplicateLeaves}]`)
  }
  const missingInRecord = treePanels.filter((p) => !layout.panels[p])
  const missingInTree = recordPanels.filter((p) => !treePanels.includes(p))
  if (missingInRecord.length > 0 || missingInTree.length > 0) {
    throw new Error(
      `dangling panel reference: in-tree-not-record [${missingInRecord}], in-record-not-tree [${missingInTree}]`
    )
  }

  // Empty workspace consistency.
  if (!layout.root && recordPanels.length > 0) {
    throw new Error('root is null but panels exist')
  }

  // One Agent Instance has at most one tab in the whole window.
  const allTabs = Object.values(layout.panels).flatMap((p) => p.tabs)
  const seen = new Set<string>()
  for (const tab of allTabs) {
    if (seen.has(tab)) {
      throw new Error(`tab ${tab} appears in more than one panel`)
    }
    seen.add(tab)
  }

  // Every active tab belongs to its panel.
  for (const [key, panel] of Object.entries(layout.panels)) {
    if (panel.activeTabId && !panel.tabs.includes(panel.activeTabId)) {
      throw new Error(`panel ${key} has an activeTabId outside its tabs`)
    }
  }

  // Ratios stay strictly inside (0, 1).
  const checkRatios = (node: LayoutNode | null): void => {
    if (!node) return
    if (node.kind === 'split') {
      if (node.ratio <= 0 || node.ratio >= 1) {
        throw new Error(`split ${node.splitNodeId} ratio out of range: ${node.ratio}`)
      }
      checkRatios(node.first)
      checkRatios(node.second)
    }
  }
  checkRatios(layout.root)

  // Focus references an existing panel.
  if (layout.focusedPanelId && !layout.panels[layout.focusedPanelId]) {
    throw new Error(`focusedPanelId ${layout.focusedPanelId} does not exist`)
  }
}
