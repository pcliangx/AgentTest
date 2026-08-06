import { describe, it, expect } from 'vitest'
import { id } from './contract'
import type {
  AgentInstanceId,
  LayoutNode,
  PanelId,
  SplitNodeId,
  WorkspaceLayoutViewModel
} from './contract'
import {
  applyLayoutOperation,
  assertLayoutInvariants,
  type LayoutIdGenerator
} from './layout-reducer'

// ---------------------------------------------------------------------------
// Builders & deterministic IDs
// ---------------------------------------------------------------------------

const P = (n: number): PanelId => id(`panel-${n}`, 'PanelId')
const S = (n: number): SplitNodeId => id(`split-${n}`, 'SplitNodeId')
const A = (name: string): AgentInstanceId => id(name, 'AgentInstanceId')

/** Deterministic generator: panel-new-N / split-new-N. */
function makeIds(): LayoutIdGenerator {
  let panels = 0
  let splits = 0
  return {
    newPanelId: () => id(`panel-new-${++panels}`, 'PanelId'),
    newSplitNodeId: () => id(`split-new-${++splits}`, 'SplitNodeId')
  }
}

function emptyLayout(): WorkspaceLayoutViewModel {
  return { root: null, panels: {} }
}

function singlePanelLayout(
  panelId: PanelId,
  tabs: AgentInstanceId[]
): WorkspaceLayoutViewModel {
  return {
    root: { kind: 'panel', panelId },
    panels: { [panelId]: { tabs, activeTabId: tabs[0] } },
    focusedPanelId: panelId
  }
}

// ---------------------------------------------------------------------------
// split-panel
// ---------------------------------------------------------------------------

describe('layout-reducer — split-panel', () => {
  it('splits a panel horizontally, leaving an empty sibling panel', () => {
    const layout = singlePanelLayout(P(1), [A('a'), A('b')])
    const result = applyLayoutOperation(
      layout,
      { kind: 'split-panel', panelId: P(1), direction: 'horizontal' },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.root).toEqual({
      kind: 'split',
      splitNodeId: id('split-new-1', 'SplitNodeId'),
      direction: 'horizontal',
      ratio: 0.5,
      first: { kind: 'panel', panelId: P(1) },
      second: { kind: 'panel', panelId: id('panel-new-1', 'PanelId') }
    })
    // Original panel keeps its tabs; the new panel is intentionally empty.
    expect(result.layout.panels[P(1)].tabs).toEqual([A('a'), A('b')])
    expect(result.layout.panels[id('panel-new-1', 'PanelId')].tabs).toEqual([])
    expect(result.layout.focusedPanelId).toEqual(P(1))
  })

  it('rejects an unknown panel without changing the layout', () => {
    const layout = singlePanelLayout(P(1), [A('a')])
    const result = applyLayoutOperation(
      layout,
      { kind: 'split-panel', panelId: P(99), direction: 'vertical' },
      makeIds()
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid-target')
  })

  it('splits vertically inside an existing split tree', () => {
    const ids = makeIds()
    const splitOnce = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a')]),
      { kind: 'split-panel', panelId: P(1), direction: 'horizontal' },
      ids
    )
    expect(splitOnce.ok).toBe(true)
    if (!splitOnce.ok) return
    const newPanel = id('panel-new-1', 'PanelId')
    const splitTwice = applyLayoutOperation(
      splitOnce.layout,
      { kind: 'split-panel', panelId: newPanel, direction: 'vertical' },
      ids
    )
    expect(splitTwice.ok).toBe(true)
    if (!splitTwice.ok) return
    const root = splitTwice.layout.root
    expect(root?.kind).toBe('split')
    if (root?.kind !== 'split') return
    expect(root.second).toEqual({
      kind: 'split',
      splitNodeId: id('split-new-2', 'SplitNodeId'),
      direction: 'vertical',
      ratio: 0.5,
      first: { kind: 'panel', panelId: newPanel },
      second: { kind: 'panel', panelId: id('panel-new-2', 'PanelId') }
    })
  })
})

// ---------------------------------------------------------------------------
// open-tab-in-new-panel
// ---------------------------------------------------------------------------

describe('layout-reducer — open-tab-in-new-panel', () => {
  it('creates a new panel after the reference panel and opens the tab there', () => {
    const layout = singlePanelLayout(P(1), [A('a')])
    const result = applyLayoutOperation(
      layout,
      {
        kind: 'open-tab-in-new-panel',
        agentInstanceId: A('b'),
        direction: 'horizontal'
      },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const newPanel = id('panel-new-1', 'PanelId')
    expect(result.layout.root).toMatchObject({
      kind: 'split',
      direction: 'horizontal',
      first: { kind: 'panel', panelId: P(1) },
      second: { kind: 'panel', panelId: newPanel }
    })
    expect(result.layout.panels[newPanel]).toEqual({
      tabs: [A('b')],
      activeTabId: A('b')
    })
    expect(result.layout.focusedPanelId).toEqual(newPanel)
    // Original panel untouched.
    expect(result.layout.panels[P(1)].tabs).toEqual([A('a')])
  })

  it('honours position "before" and an explicit reference panel', () => {
    const layout = singlePanelLayout(P(1), [A('a')])
    const result = applyLayoutOperation(
      layout,
      {
        kind: 'open-tab-in-new-panel',
        agentInstanceId: A('b'),
        direction: 'vertical',
        position: 'before',
        relativeToPanelId: P(1)
      },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.root).toMatchObject({
      direction: 'vertical',
      first: { kind: 'panel', panelId: id('panel-new-1', 'PanelId') },
      second: { kind: 'panel', panelId: P(1) }
    })
  })

  it('moves an already-open tab instead of duplicating it', () => {
    // Two panels: P1 with [a], P2 with [b]; open a in a new panel relative to P2.
    const ids = makeIds()
    const step1 = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a')]),
      { kind: 'open-tab-in-new-panel', agentInstanceId: A('b'), direction: 'horizontal' },
      ids
    )
    expect(step1.ok).toBe(true)
    if (!step1.ok) return
    const p2 = id('panel-new-1', 'PanelId')
    const step2 = applyLayoutOperation(
      step1.layout,
      {
        kind: 'open-tab-in-new-panel',
        agentInstanceId: A('a'),
        direction: 'vertical',
        relativeToPanelId: p2
      },
      ids
    )
    expect(step2.ok).toBe(true)
    if (!step2.ok) return
    // a lives in exactly one panel now — the new one.
    const owners = Object.values(step2.layout.panels).filter((p) =>
      p.tabs.includes(A('a'))
    )
    expect(owners).toHaveLength(1)
    // P1 became empty after the move and was pruned.
    expect(step2.layout.panels[P(1)]).toBeUndefined()
    assertLayoutInvariants(step2.layout)
  })

  it('creates the first panel when the workspace is empty', () => {
    const result = applyLayoutOperation(
      emptyLayout(),
      { kind: 'open-tab-in-new-panel', agentInstanceId: A('a'), direction: 'horizontal' },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.root).toEqual({
      kind: 'panel',
      panelId: id('panel-new-1', 'PanelId')
    })
    expect(result.layout.panels[id('panel-new-1', 'PanelId')]).toEqual({
      tabs: [A('a')],
      activeTabId: A('a')
    })
  })

  it('never duplicates the tab when panel IDs are integer-like', () => {
    // JavaScript enumerates integer-like keys first (ascending), before
    // string keys — independent of insertion order. The reducer must not
    // let the freshly created panel masquerade as the tab's former owner.
    let n = 0
    const integerLikeIds: LayoutIdGenerator = {
      newPanelId: () => id(String(++n), 'PanelId'),
      newSplitNodeId: () => id(`split-new-${n}`, 'SplitNodeId')
    }
    const existing = id('2', 'PanelId')
    const layout: WorkspaceLayoutViewModel = {
      root: { kind: 'panel', panelId: existing },
      panels: {
        [existing]: { tabs: [A('a')], activeTabId: A('a') }
      },
      focusedPanelId: existing
    }

    const result = applyLayoutOperation(
      layout,
      { kind: 'open-tab-in-new-panel', agentInstanceId: A('a'), direction: 'horizontal' },
      integerLikeIds
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const owners = Object.values(result.layout.panels).filter((p) =>
      p.tabs.includes(A('a'))
    )
    expect(owners).toHaveLength(1)
    expect(result.layout.panels[existing].tabs).toEqual([])
    assertLayoutInvariants(result.layout)
  })
})

// ---------------------------------------------------------------------------
// move-tab
// ---------------------------------------------------------------------------

describe('layout-reducer — move-tab', () => {
  function twoPanelLayout(): WorkspaceLayoutViewModel {
    const split = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a'), A('b')]),
      { kind: 'open-tab-in-new-panel', agentInstanceId: A('c'), direction: 'horizontal' },
      makeIds()
    )
    if (!split.ok) throw new Error('setup failed')
    return split.layout
  }

  it('moves a tab to another panel, activates it and prunes the emptied panel', () => {
    const layout = twoPanelLayout()
    const p2 = id('panel-new-1', 'PanelId')
    const result = applyLayoutOperation(
      layout,
      { kind: 'move-tab', agentInstanceId: A('c'), targetPanelId: P(1) },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.panels[P(1)].tabs).toEqual([A('a'), A('b'), A('c')])
    expect(result.layout.panels[P(1)].activeTabId).toEqual(A('c'))
    // Source panel emptied → pruned; tree collapses to a single panel.
    expect(result.layout.panels[p2]).toBeUndefined()
    expect(result.layout.root).toEqual({ kind: 'panel', panelId: P(1) })
    expect(result.layout.focusedPanelId).toEqual(P(1))
  })

  it('keeps the source panel when it still has tabs left', () => {
    const layout = twoPanelLayout()
    const result = applyLayoutOperation(
      layout,
      { kind: 'move-tab', agentInstanceId: A('a'), targetPanelId: id('panel-new-1', 'PanelId') },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.panels[P(1)].tabs).toEqual([A('b')])
    expect(result.layout.panels[id('panel-new-1', 'PanelId')].tabs).toEqual([
      A('c'),
      A('a')
    ])
    expect(result.layout.panels[P(1)].activeTabId).toEqual(A('b'))
  })

  it('moving within the same panel only activates the tab', () => {
    const layout = singlePanelLayout(P(1), [A('a'), A('b')])
    const result = applyLayoutOperation(
      layout,
      { kind: 'move-tab', agentInstanceId: A('a'), targetPanelId: P(1) },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.panels[P(1)].tabs).toEqual([A('a'), A('b')])
    expect(result.layout.panels[P(1)].activeTabId).toEqual(A('a'))
  })

  it('rejects an unknown target panel or tab', () => {
    const layout = singlePanelLayout(P(1), [A('a')])
    const badPanel = applyLayoutOperation(
      layout,
      { kind: 'move-tab', agentInstanceId: A('a'), targetPanelId: P(99) },
      makeIds()
    )
    expect(badPanel.ok).toBe(false)
    const badTab = applyLayoutOperation(
      layout,
      { kind: 'move-tab', agentInstanceId: A('nope'), targetPanelId: P(1) },
      makeIds()
    )
    expect(badTab.ok).toBe(false)
  })

  // #77: insertionIndex for pointer drag-and-drop reordering.
  it('reorders tabs within the same panel at a given insertion index', () => {
    const layout = singlePanelLayout(P(1), [A('a'), A('b'), A('c')])
    // Move 'c' to position 0 → [c, a, b]
    const result = applyLayoutOperation(
      layout,
      { kind: 'move-tab', agentInstanceId: A('c'), targetPanelId: P(1), insertionIndex: 0 },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.panels[P(1)].tabs).toEqual([A('c'), A('a'), A('b')])
    expect(result.layout.panels[P(1)].activeTabId).toEqual(A('c'))
  })

  it('reorders within same panel moving a tab to the end', () => {
    const layout = singlePanelLayout(P(1), [A('a'), A('b'), A('c')])
    // Move 'a' to position 3 (end) → [b, c, a]
    const result = applyLayoutOperation(
      layout,
      { kind: 'move-tab', agentInstanceId: A('a'), targetPanelId: P(1), insertionIndex: 3 },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.panels[P(1)].tabs).toEqual([A('b'), A('c'), A('a')])
  })

  it('treats a no-op same-panel insertion as activation only', () => {
    const layout = singlePanelLayout(P(1), [A('a'), A('b'), A('c')])
    // Move 'b' to index 1 — it's already at index 1.
    const result = applyLayoutOperation(
      layout,
      { kind: 'move-tab', agentInstanceId: A('b'), targetPanelId: P(1), insertionIndex: 1 },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.panels[P(1)].tabs).toEqual([A('a'), A('b'), A('c')])
  })

  it('inserts at a specific index when moving across panels', () => {
    const layout = twoPanelLayout()
    const p2 = id('panel-new-1', 'PanelId')
    // P1 has [a, b], P2 has [c]. Move 'a' from P1 to P2 at index 0 → [a, c].
    const result = applyLayoutOperation(
      layout,
      { kind: 'move-tab', agentInstanceId: A('a'), targetPanelId: p2, insertionIndex: 0 },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.panels[p2].tabs).toEqual([A('a'), A('c')])
    expect(result.layout.panels[P(1)].tabs).toEqual([A('b')])
  })

  it('clamps an out-of-range insertion index', () => {
    const layout = singlePanelLayout(P(1), [A('a'), A('b')])
    // insertionIndex 99 clamps to 2 (end after removal).
    const result = applyLayoutOperation(
      layout,
      { kind: 'move-tab', agentInstanceId: A('a'), targetPanelId: P(1), insertionIndex: 99 },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.panels[P(1)].tabs).toEqual([A('b'), A('a')])
  })
})

// ---------------------------------------------------------------------------
// close-tab / close-panel pruning
// ---------------------------------------------------------------------------

describe('layout-reducer — close-tab and close-panel', () => {
  it('close-tab prunes the emptied panel and lifts the sibling subtree', () => {
    // Build: root split h [ P1[a] | split v [ P2[b] | P3[c] ] ]
    const ids = makeIds()
    const s1 = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a')]),
      { kind: 'open-tab-in-new-panel', agentInstanceId: A('b'), direction: 'horizontal' },
      ids
    )
    if (!s1.ok) throw new Error('setup failed')
    const p2 = id('panel-new-1', 'PanelId')
    const s2 = applyLayoutOperation(
      s1.layout,
      { kind: 'open-tab-in-new-panel', agentInstanceId: A('c'), direction: 'vertical', relativeToPanelId: p2 },
      ids
    )
    if (!s2.ok) throw new Error('setup failed')
    const p3 = id('panel-new-2', 'PanelId')

    const closed = applyLayoutOperation(
      s2.layout,
      { kind: 'close-tab', panelId: p2, agentInstanceId: A('b') },
      ids
    )
    expect(closed.ok).toBe(true)
    if (!closed.ok) return
    // P2 removed; the vertical split collapses; P3 takes its place.
    expect(closed.layout.panels[p2]).toBeUndefined()
    expect(closed.layout.root).toMatchObject({
      kind: 'split',
      direction: 'horizontal',
      first: { kind: 'panel', panelId: P(1) },
      second: { kind: 'panel', panelId: p3 }
    })
    assertLayoutInvariants(closed.layout)
  })

  it('closing the last tab of the only panel yields the empty workspace', () => {
    const layout = singlePanelLayout(P(1), [A('a')])
    const result = applyLayoutOperation(
      layout,
      { kind: 'close-tab', panelId: P(1), agentInstanceId: A('a') },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.root).toBeNull()
    expect(result.layout.panels).toEqual({})
    expect(result.layout.focusedPanelId).toBeUndefined()
  })

  // UX-v0.2 §7.2(5) / ADR-0009: when ALL tabs are closed the workspace
  // returns to the empty state — no orphaned empty panel may remain,
  // even one created by an earlier split.
  it('closing the globally last tab clears the whole tree, including empty siblings', () => {
    const ids = makeIds()
    const split = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a')]),
      { kind: 'split-panel', panelId: P(1), direction: 'horizontal' },
      ids
    )
    expect(split.ok).toBe(true)
    if (!split.ok) return

    const result = applyLayoutOperation(
      split.layout,
      { kind: 'close-tab', panelId: P(1), agentInstanceId: A('a') },
      ids
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.root).toBeNull()
    expect(result.layout.panels).toEqual({})
    expect(result.layout.focusedPanelId).toBeUndefined()
    assertLayoutInvariants(result.layout)
  })

  it('close-panel requires a migration target when the panel has tabs', () => {
    const layout = singlePanelLayout(P(1), [A('a'), A('b')])
    const result = applyLayoutOperation(
      layout,
      { kind: 'close-panel', panelId: P(1) },
      makeIds()
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invariant-violation')
  })

  it('close-panel migrates all tabs to the chosen panel and removes itself', () => {
    const s1 = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a'), A('b')]),
      { kind: 'open-tab-in-new-panel', agentInstanceId: A('c'), direction: 'horizontal' },
      makeIds()
    )
    if (!s1.ok) throw new Error('setup failed')
    const p2 = id('panel-new-1', 'PanelId')
    const result = applyLayoutOperation(
      s1.layout,
      { kind: 'close-panel', panelId: p2, migrateToPanelId: P(1) },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.panels[p2]).toBeUndefined()
    expect(result.layout.panels[P(1)].tabs).toEqual([A('a'), A('b'), A('c')])
    expect(result.layout.panels[P(1)].activeTabId).toEqual(A('c'))
    expect(result.layout.root).toEqual({ kind: 'panel', panelId: P(1) })
  })

  it('close-panel removes an empty panel without a migration target', () => {
    const s1 = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a')]),
      { kind: 'split-panel', panelId: P(1), direction: 'horizontal' },
      makeIds()
    )
    if (!s1.ok) throw new Error('setup failed')
    const p2 = id('panel-new-1', 'PanelId')
    const result = applyLayoutOperation(
      s1.layout,
      { kind: 'close-panel', panelId: p2 },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.root).toEqual({ kind: 'panel', panelId: P(1) })
  })
})

// ---------------------------------------------------------------------------
// resize-split
// ---------------------------------------------------------------------------

describe('layout-reducer — resize-split', () => {
  it('updates the ratio and clamps it into (0, 1)', () => {
    const s1 = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a')]),
      { kind: 'split-panel', panelId: P(1), direction: 'horizontal' },
      makeIds()
    )
    if (!s1.ok) throw new Error('setup failed')
    const splitId = id('split-new-1', 'SplitNodeId')

    const resized = applyLayoutOperation(
      s1.layout,
      { kind: 'resize-split', splitNodeId: splitId, ratio: 0.7 },
      makeIds()
    )
    expect(resized.ok).toBe(true)
    if (!resized.ok) return
    expect(resized.layout.root).toMatchObject({ ratio: 0.7 })

    const clampedLow = applyLayoutOperation(
      s1.layout,
      { kind: 'resize-split', splitNodeId: splitId, ratio: 0.01 },
      makeIds()
    )
    expect(clampedLow.ok).toBe(true)
    if (!clampedLow.ok) return
    expect(clampedLow.layout.root).toMatchObject({ ratio: 0.1 })

    const clampedHigh = applyLayoutOperation(
      s1.layout,
      { kind: 'resize-split', splitNodeId: splitId, ratio: 0.99 },
      makeIds()
    )
    expect(clampedHigh.ok).toBe(true)
    if (!clampedHigh.ok) return
    expect(clampedHigh.layout.root).toMatchObject({ ratio: 0.9 })
  })

  it('rejects an unknown split node', () => {
    const layout = singlePanelLayout(P(1), [A('a')])
    const result = applyLayoutOperation(
      layout,
      { kind: 'resize-split', splitNodeId: S(99), ratio: 0.5 },
      makeIds()
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid-target')
  })
})

// ---------------------------------------------------------------------------
// prune-empty-panels
// ---------------------------------------------------------------------------

describe('layout-reducer — prune-empty-panels', () => {
  it('removes split-created empty panels and collapses the tree', () => {
    const s1 = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a')]),
      { kind: 'split-panel', panelId: P(1), direction: 'horizontal' },
      makeIds()
    )
    if (!s1.ok) throw new Error('setup failed')
    const result = applyLayoutOperation(
      s1.layout,
      { kind: 'prune-empty-panels' },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.root).toEqual({ kind: 'panel', panelId: P(1) })
    expect(Object.keys(result.layout.panels)).toEqual([P(1)])
  })
})

// ---------------------------------------------------------------------------
// Purity & unsupported operations
// ---------------------------------------------------------------------------

describe('layout-reducer — purity', () => {
  it('never mutates the input layout', () => {
    const layout = singlePanelLayout(P(1), [A('a'), A('b')])
    const frozen = structuredClone(layout)
    applyLayoutOperation(
      layout,
      { kind: 'split-panel', panelId: P(1), direction: 'horizontal' },
      makeIds()
    )
    applyLayoutOperation(
      layout,
      { kind: 'close-tab', panelId: P(1), agentInstanceId: A('a') },
      makeIds()
    )
    expect(layout).toEqual(frozen)
  })
})

// ---------------------------------------------------------------------------
// Property / invariant tests — random legal command sequences
// ---------------------------------------------------------------------------

/** mulberry32 — small deterministic PRNG, no external dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomIds(rand: () => number): LayoutIdGenerator {
  return {
    newPanelId: () => id(`panel-r${Math.floor(rand() * 1e9)}`, 'PanelId'),
    newSplitNodeId: () => id(`split-r${Math.floor(rand() * 1e9)}`, 'SplitNodeId')
  }
}

function collectPanelIds(node: LayoutNode | null): PanelId[] {
  if (!node) return []
  if (node.kind === 'panel') return [node.panelId]
  return [...collectPanelIds(node.first), ...collectPanelIds(node.second)]
}

describe('layout-reducer — property invariants over random command sequences', () => {
  const TAB_POOL = ['a', 'b', 'c', 'd', 'e'].map(A)
  const SEEDS = [1, 42, 1337]

  for (const seed of SEEDS) {
    it(`holds invariants after 200 random operations (seed ${seed})`, () => {
      const rand = mulberry32(seed)
      const ids = randomIds(rand)
      let layout: WorkspaceLayoutViewModel = singlePanelLayout(P(1), [A('a')])

      for (let step = 0; step < 200; step++) {
        const panels = Object.keys(layout.panels) as PanelId[]
        const treePanels = collectPanelIds(layout.root)
        const allTabs = Object.values(layout.panels).flatMap((p) => p.tabs)
        const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
        const opRoll = rand()

        let operation
        if (opRoll < 0.2 && panels.length > 0) {
          operation = {
            kind: 'split-panel',
            panelId: pick(panels),
            direction: rand() < 0.5 ? 'horizontal' : 'vertical'
          } as const
        } else if (opRoll < 0.4 && allTabs.length > 0 && panels.length > 0) {
          operation = {
            kind: 'move-tab',
            agentInstanceId: pick(allTabs),
            targetPanelId: pick(panels)
          } as const
        } else if (opRoll < 0.55 && allTabs.length > 0) {
          const tab = pick(allTabs)
          const ownerOfTab = panels.find((pid) =>
            layout.panels[pid].tabs.includes(tab)
          )
          operation = ownerOfTab
            ? ({
                kind: 'close-tab',
                panelId: ownerOfTab,
                agentInstanceId: tab
              } as const)
            : ({
                kind: 'open-tab',
                panelId: pick(panels) ?? P(1),
                agentInstanceId: tab
              } as const)
        } else if (opRoll < 0.75) {
          operation = {
            kind: 'open-tab-in-new-panel',
            agentInstanceId:
              rand() < 0.5 ? pick(TAB_POOL) : A(`extra-${step % 7}`),
            direction: rand() < 0.5 ? 'horizontal' : 'vertical',
            position: rand() < 0.5 ? 'before' : 'after',
            relativeToPanelId:
              treePanels.length > 0 ? pick(treePanels) : undefined
          } as const
        } else if (opRoll < 0.85 && treePanels.length > 1) {
          const target = pick(treePanels)
          const others = treePanels.filter((p) => p !== target)
          operation = {
            kind: 'close-panel',
            panelId: target,
            migrateToPanelId:
              layout.panels[target].tabs.length > 0 ? pick(others) : undefined
          } as const
        } else if (opRoll < 0.9) {
          // Focus enter/exit mixes with structural operations.
          operation =
            rand() < 0.5 && panels.length > 0
              ? ({ kind: 'focus-panel', panelId: pick(panels) } as const)
              : ({ kind: 'focus-panel' } as const)
        } else if (opRoll < 0.94 && panels.length > 0) {
          operation = {
            kind: 'apply-analysis-preset',
            panelId: pick(panels)
          } as const
        } else if (opRoll < 0.98) {
          const splits: SplitNodeId[] = []
          const walk = (n: LayoutNode | null) => {
            if (!n) return
            if (n.kind === 'split') {
              splits.push(n.splitNodeId)
              walk(n.first)
              walk(n.second)
            }
          }
          walk(layout.root)
          operation =
            splits.length > 0
              ? ({
                  kind: 'resize-split',
                  splitNodeId: pick(splits),
                  ratio: rand()
                } as const)
              : ({ kind: 'prune-empty-panels' } as const)
        } else {
          operation = { kind: 'prune-empty-panels' } as const
        }

        const result = applyLayoutOperation(layout, operation, ids)
        if (result.ok) {
          layout = result.layout
        }
        assertLayoutInvariants(layout)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// focus-panel — temporary Focus, lossless restore (#5)
// ---------------------------------------------------------------------------

describe('layout-reducer — focus-panel', () => {
  function twoPanelLayout(ids: LayoutIdGenerator) {
    const split = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a')]),
      { kind: 'split-panel', panelId: P(1), direction: 'horizontal' },
      ids
    )
    if (!split.ok) throw new Error('setup failed')
    return split.layout
  }

  it('enters Focus on an existing panel without touching the tree', () => {
    const ids = makeIds()
    const layout = twoPanelLayout(ids)
    const p2 = id('panel-new-1', 'PanelId')

    const result = applyLayoutOperation(
      layout,
      { kind: 'focus-panel', panelId: p2 },
      ids
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Focus is a temporary view state: the split tree, tabs and ratios are
    // exactly what they were, so exiting later restores them losslessly.
    expect(result.layout.root).toEqual(layout.root)
    expect(result.layout.panels).toEqual(layout.panels)
    expect(result.layout.temporaryFocusPanelId).toEqual(p2)
    expect(result.layout.focusedPanelId).toEqual(p2)
    assertLayoutInvariants(result.layout)
  })

  it('exiting Focus clears the temporary focus and keeps the full tree', () => {
    const ids = makeIds()
    const layout = twoPanelLayout(ids)
    const p2 = id('panel-new-1', 'PanelId')
    const focused = applyLayoutOperation(
      layout,
      { kind: 'focus-panel', panelId: p2 },
      ids
    )
    if (!focused.ok) throw new Error('setup failed')

    const result = applyLayoutOperation(
      focused.layout,
      { kind: 'focus-panel' },
      ids
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.temporaryFocusPanelId).toBeUndefined()
    expect(result.layout.root).toEqual(layout.root)
    expect(result.layout.panels).toEqual(layout.panels)
    assertLayoutInvariants(result.layout)
  })

  it('moves Focus to another panel when already focused', () => {
    const ids = makeIds()
    const layout = twoPanelLayout(ids)
    const p2 = id('panel-new-1', 'PanelId')
    const first = applyLayoutOperation(
      layout,
      { kind: 'focus-panel', panelId: p2 },
      ids
    )
    if (!first.ok) throw new Error('setup failed')

    const result = applyLayoutOperation(
      first.layout,
      { kind: 'focus-panel', panelId: P(1) },
      ids
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.temporaryFocusPanelId).toEqual(P(1))
    expect(result.layout.focusedPanelId).toEqual(P(1))
  })

  it('rejects focusing a panel that does not exist', () => {
    const layout = singlePanelLayout(P(1), [A('a')])
    const result = applyLayoutOperation(
      layout,
      { kind: 'focus-panel', panelId: P(99) },
      makeIds()
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid-target')
  })

  it('clears the temporary Focus when the focused panel is closed', () => {
    const ids = makeIds()
    const layout = twoPanelLayout(ids)
    const p2 = id('panel-new-1', 'PanelId')
    const focused = applyLayoutOperation(
      layout,
      { kind: 'focus-panel', panelId: p2 },
      ids
    )
    if (!focused.ok) throw new Error('setup failed')

    const result = applyLayoutOperation(
      focused.layout,
      { kind: 'close-panel', panelId: p2 },
      ids
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.temporaryFocusPanelId).toBeUndefined()
    assertLayoutInvariants(result.layout)
  })

  it('clears the temporary Focus when the focused panel loses its last tab', () => {
    const ids = makeIds()
    const split = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a')]),
      {
        kind: 'open-tab-in-new-panel',
        agentInstanceId: A('b'),
        direction: 'horizontal'
      },
      ids
    )
    if (!split.ok) throw new Error('setup failed')
    const p2 = id('panel-new-1', 'PanelId')
    const focused = applyLayoutOperation(
      split.layout,
      { kind: 'focus-panel', panelId: p2 },
      ids
    )
    if (!focused.ok) throw new Error('setup failed')

    // Closing b empties and prunes the focused panel.
    const result = applyLayoutOperation(
      focused.layout,
      { kind: 'close-tab', panelId: p2, agentInstanceId: A('b') },
      ids
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.temporaryFocusPanelId).toBeUndefined()
    expect(result.layout.focusedPanelId).toEqual(P(1))
    assertLayoutInvariants(result.layout)
  })

  it('opening a tab owned by a hidden panel moves the temporary Focus to it', () => {
    const ids = makeIds()
    // Split: [ P1[a] | P2[] ]; open b in P2, then Focus P2.
    const split = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a')]),
      { kind: 'open-tab-in-new-panel', agentInstanceId: A('b'), direction: 'horizontal' },
      ids
    )
    if (!split.ok) throw new Error('setup failed')
    const p2 = id('panel-new-1', 'PanelId')
    const focused = applyLayoutOperation(
      split.layout,
      { kind: 'focus-panel', panelId: p2 },
      ids
    )
    if (!focused.ok) throw new Error('setup failed')

    // The user opens a, which lives in the hidden P1 — the temporary Focus
    // must follow, or the tab they just asked for stays invisible.
    const result = applyLayoutOperation(
      focused.layout,
      { kind: 'open-tab', panelId: p2, agentInstanceId: A('a') },
      ids
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.focusedPanelId).toEqual(P(1))
    expect(result.layout.temporaryFocusPanelId).toEqual(P(1))
    assertLayoutInvariants(result.layout)
  })

  it('moving a tab across panels moves the temporary Focus with it', () => {
    const ids = makeIds()
    const split = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a')]),
      { kind: 'open-tab-in-new-panel', agentInstanceId: A('b'), direction: 'horizontal' },
      ids
    )
    if (!split.ok) throw new Error('setup failed')
    const p2 = id('panel-new-1', 'PanelId')
    // Give the focused panel a second tab so it survives the move.
    const withC = applyLayoutOperation(
      split.layout,
      { kind: 'open-tab', panelId: p2, agentInstanceId: A('c') },
      ids
    )
    if (!withC.ok) throw new Error('setup failed')
    const focused = applyLayoutOperation(
      withC.layout,
      { kind: 'focus-panel', panelId: p2 },
      ids
    )
    if (!focused.ok) throw new Error('setup failed')

    // Moving b OUT of the focused panel into the hidden P1: the user
    // follows the tab, so the temporary Focus must too.
    const result = applyLayoutOperation(
      focused.layout,
      { kind: 'move-tab', agentInstanceId: A('b'), targetPanelId: P(1) },
      ids
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.focusedPanelId).toEqual(P(1))
    expect(result.layout.temporaryFocusPanelId).toEqual(P(1))
    assertLayoutInvariants(result.layout)
  })
})

// ---------------------------------------------------------------------------
// apply-analysis-preset — one main + two auxiliary panels (#5)
// ---------------------------------------------------------------------------

describe('layout-reducer — apply-analysis-preset', () => {
  it('builds the one-main-two-auxiliary tree from a single panel', () => {
    const result = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a'), A('b')]),
      { kind: 'apply-analysis-preset', panelId: P(1) },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const aux1 = id('panel-new-1', 'PanelId')
    const aux2 = id('panel-new-2', 'PanelId')
    // The preset is a plain split tree (UX-v0.2 §7.1) — no second layout
    // model: horizontal main at 61%, two auxiliaries stacked at 52%.
    expect(result.layout.root).toEqual({
      kind: 'split',
      splitNodeId: id('split-new-1', 'SplitNodeId'),
      direction: 'horizontal',
      ratio: 0.61,
      first: { kind: 'panel', panelId: P(1) },
      second: {
        kind: 'split',
        splitNodeId: id('split-new-2', 'SplitNodeId'),
        direction: 'vertical',
        ratio: 0.52,
        first: { kind: 'panel', panelId: aux1 },
        second: { kind: 'panel', panelId: aux2 }
      }
    })
    // Main keeps its tabs untouched; both auxiliaries start empty.
    expect(result.layout.panels[P(1)].tabs).toEqual([A('a'), A('b')])
    expect(result.layout.panels[P(1)].activeTabId).toEqual(A('a'))
    expect(result.layout.panels[aux1].tabs).toEqual([])
    expect(result.layout.panels[aux2].tabs).toEqual([])
    expect(result.layout.focusedPanelId).toEqual(P(1))
    assertLayoutInvariants(result.layout)
  })

  it('reuses existing panels in tree order for the auxiliary slots', () => {
    const ids = makeIds()
    const s1 = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a')]),
      {
        kind: 'open-tab-in-new-panel',
        agentInstanceId: A('b'),
        direction: 'horizontal'
      },
      ids
    )
    if (!s1.ok) throw new Error('setup failed')
    const p2 = id('panel-new-1', 'PanelId')
    const s2 = applyLayoutOperation(
      s1.layout,
      {
        kind: 'open-tab-in-new-panel',
        agentInstanceId: A('c'),
        direction: 'horizontal'
      },
      ids
    )
    if (!s2.ok) throw new Error('setup failed')
    const p3 = id('panel-new-2', 'PanelId')
    // Tree order: P1, p2, p3. Main = p2 → auxiliaries reuse P1 and p3.
    const result = applyLayoutOperation(
      s2.layout,
      { kind: 'apply-analysis-preset', panelId: p2 },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // No new panels allocated: exactly the same three panel records.
    expect(Object.keys(result.layout.panels).sort()).toEqual(
      [P(1), p2, p3].sort()
    )
    expect(result.layout.root).toMatchObject({
      direction: 'horizontal',
      first: { kind: 'panel', panelId: p2 },
      second: {
        direction: 'vertical',
        first: { kind: 'panel', panelId: P(1) },
        second: { kind: 'panel', panelId: p3 }
      }
    })
    // Every panel keeps its own tab.
    expect(result.layout.panels[P(1)].tabs).toEqual([A('a')])
    expect(result.layout.panels[p2].tabs).toEqual([A('b')])
    expect(result.layout.panels[p3].tabs).toEqual([A('c')])
    expect(result.layout.focusedPanelId).toEqual(p2)
    assertLayoutInvariants(result.layout)
  })

  it('migrates leftover tabs into the main panel instead of losing them', () => {
    const ids = makeIds()
    let layout = singlePanelLayout(P(1), [A('a')])
    for (const tab of [A('b'), A('c'), A('d')]) {
      const step = applyLayoutOperation(
        layout,
        { kind: 'open-tab-in-new-panel', agentInstanceId: tab, direction: 'horizontal' },
        ids
      )
      if (!step.ok) throw new Error('setup failed')
      layout = step.layout
    }
    // Tree order: P1(a), p2(b), p3(c), p4(d). Main = p2.
    const p2 = id('panel-new-1', 'PanelId')
    const p3 = id('panel-new-2', 'PanelId')
    const p4 = id('panel-new-3', 'PanelId')
    const result = applyLayoutOperation(
      layout,
      { kind: 'apply-analysis-preset', panelId: p2 },
      makeIds()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Auxiliaries reuse P1 and p3; p4 is pruned and its tab migrates into
    // the main panel — no tab is ever dropped by the preset.
    expect(Object.keys(result.layout.panels).sort()).toEqual(
      [P(1), p2, p3].sort()
    )
    expect(result.layout.panels[p2].tabs).toEqual([A('b'), A('d')])
    expect(result.layout.panels[P(1)].tabs).toEqual([A('a')])
    expect(result.layout.panels[p3].tabs).toEqual([A('c')])
    assertLayoutInvariants(result.layout)
  })

  it('clears any temporary Focus — the user asked for the three-panel view', () => {
    const ids = makeIds()
    const s1 = applyLayoutOperation(
      singlePanelLayout(P(1), [A('a')]),
      {
        kind: 'open-tab-in-new-panel',
        agentInstanceId: A('b'),
        direction: 'horizontal'
      },
      ids
    )
    if (!s1.ok) throw new Error('setup failed')
    const p2 = id('panel-new-1', 'PanelId')

    // Focus on the would-be main panel is cleared as well: showing only
    // one panel right after the user applied a three-panel preset would
    // contradict the explicit action.
    const focusedMain = applyLayoutOperation(
      s1.layout,
      { kind: 'focus-panel', panelId: p2 },
      ids
    )
    if (!focusedMain.ok) throw new Error('setup failed')
    const result = applyLayoutOperation(
      focusedMain.layout,
      { kind: 'apply-analysis-preset', panelId: p2 },
      ids
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.layout.temporaryFocusPanelId).toBeUndefined()
    assertLayoutInvariants(result.layout)
  })

  it('rejects an unknown main panel without changing the layout', () => {
    const layout = singlePanelLayout(P(1), [A('a')])
    const frozen = structuredClone(layout)
    const result = applyLayoutOperation(
      layout,
      { kind: 'apply-analysis-preset', panelId: P(99) },
      makeIds()
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid-target')
    expect(layout).toEqual(frozen)
  })

  it('rejects the preset on an empty workspace', () => {
    const result = applyLayoutOperation(
      emptyLayout(),
      { kind: 'apply-analysis-preset', panelId: P(1) },
      makeIds()
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid-target')
  })
})
