// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'
import { id } from './workbench/contract'
import type {
  CommandResult,
  WorkbenchCommand,
  WorkbenchEvent,
  WorkbenchPort,
  WorkbenchViewModel
} from './workbench/contract'

/**
 * Advanced workspace layout (#5): temporary Focus with lossless restore,
 * the one-main-two-auxiliary Analysis preset, keyboard parity with pointer
 * gestures, and 4+ panel density behaviour. Tests observe accessible roles,
 * names and the commands reaching the port — never private DOM or CSS.
 */

afterEach(() => cleanup())

async function gotoAgentsSurface(port?: WorkbenchPort) {
  const user = userEvent.setup()
  render(<ProjectShell port={port ?? new MockScenarioAdapter()} />)
  await screen.findByRole('button', { name: '概览' })
  await user.click(screen.getByRole('button', { name: 'Agent' }))
  await screen.findByRole('region', { name: 'Agent 目录' })
  return { user }
}

function panels(): HTMLElement[] {
  return screen.getAllByRole('group', { name: 'Agent 面板' })
}

/** Records every command reaching the port while delegating to the mock. */
class RecordingPort implements WorkbenchPort {
  private inner = new MockScenarioAdapter()
  readonly commands: WorkbenchCommand[] = []
  getSnapshot() {
    return this.inner.getSnapshot()
  }
  planDispatch: WorkbenchPort['planDispatch'] = (request) =>
    this.inner.planDispatch(request)
  subscribe(listener: Parameters<WorkbenchPort['subscribe']>[0]) {
    return this.inner.subscribe(listener)
  }
  dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    this.commands.push(command)
    return this.inner.dispatch(command)
  }
}

/**
 * Re-emits every event asynchronously (~20 ms). The contract makes no
 * ordering guarantees between a command response and its view-model-updated
 * event; this port exercises exactly that gap.
 */
class DelayedEventPort implements WorkbenchPort {
  private inner = new MockScenarioAdapter()
  private listeners = new Set<(event: WorkbenchEvent) => void>()
  constructor() {
    this.inner.subscribe((event) => {
      setTimeout(() => {
        for (const listener of this.listeners) listener(event)
      }, 20)
    })
  }
  getSnapshot() {
    return this.inner.getSnapshot()
  }
  planDispatch: WorkbenchPort['planDispatch'] = (request) =>
    this.inner.planDispatch(request)
  subscribe(listener: (event: WorkbenchEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    return this.inner.dispatch(command)
  }
}

// ---------------------------------------------------------------------------
// Focus — temporary maximize with lossless restore
// ---------------------------------------------------------------------------

describe('Workspace layout — Focus', () => {
  it('temporarily maximizes a panel and restores the split tree losslessly on exit', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_sql' })
    )
    expect(panels()).toHaveLength(2)

    // Enter Focus on the second panel (cc_sql's).
    await user.click(
      within(panels()[1]).getByRole('button', { name: 'Focus 此 Panel' })
    )
    expect(panels()).toHaveLength(1)
    within(panels()[0]).getByRole('tab', { name: /cc_sql/ })

    // Exit Focus: the original tree returns — two panels, both tabs, the
    // divider ratio exactly where it was.
    await user.click(screen.getByRole('button', { name: '退出 Focus' }))
    expect(panels()).toHaveLength(2)
    expect(screen.getAllByRole('tab', { name: /cc_data/ })).toHaveLength(1)
    expect(screen.getAllByRole('tab', { name: /cc_sql/ })).toHaveLength(1)
    expect(
      screen.getByRole('separator', { name: '调整分割比例' })
    ).toHaveAttribute('aria-valuenow', '50')
  })

  it('exits Focus with the Escape key', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_sql' })
    )
    await user.click(
      within(panels()[1]).getByRole('button', { name: 'Focus 此 Panel' })
    )
    expect(panels()).toHaveLength(1)

    fireEvent.keyDown(panels()[0], { key: 'Escape' })
    expect(panels()).toHaveLength(2)
    expect(screen.getAllByRole('tab', { name: /cc_sql/ })).toHaveLength(1)
  })

  it('keeps the focused panel operable while hidden panels are preserved', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_sql' })
    )
    await user.click(
      within(panels()[1]).getByRole('button', { name: 'Focus 此 Panel' })
    )

    // The focused panel still activates its tabs through the same command.
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_etl/ }))
    const ccEtlTab = screen.getByRole('tab', { name: /cc_etl/ })
    await user.click(ccEtlTab)
    expect(ccEtlTab).toHaveAttribute('aria-selected', 'true')

    // Everything comes back on exit — nothing was restructured.
    await user.click(screen.getByRole('button', { name: '退出 Focus' }))
    expect(panels()).toHaveLength(2)
    expect(screen.getAllByRole('tab', { name: /cc_data/ })).toHaveLength(1)
  })

  it('moves keyboard focus into the Focus UI on enter and restores it on exit', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_sql' })
    )
    await user.click(
      within(panels()[1]).getByRole('button', { name: 'Focus 此 Panel' })
    )

    // The trigger button unmounted — focus must land inside the Focus UI,
    // not fall back to body where Escape would never reach the handler.
    const exitButton = screen.getByRole('button', { name: '退出 Focus' })
    expect(document.activeElement).toBe(exitButton)

    // The real keyboard path: Escape from the current active element.
    await user.keyboard('{Escape}')
    expect(panels()).toHaveLength(2)

    // Focus returns to the original trigger in the restored tree.
    expect(document.activeElement).toBe(
      within(panels()[1]).getByRole('button', { name: 'Focus 此 Panel' })
    )
  })

  it('switches the temporary Focus when opening an instance owned by a hidden panel', async () => {
    const { user } = await gotoAgentsSurface()
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_sql' })
    )
    await user.click(
      within(panels()[1]).getByRole('button', { name: 'Focus 此 Panel' })
    )

    // cc_data lives in the hidden panel; the user explicitly asked for it.
    await user.click(within(directory).getByRole('button', { name: /^cc_data/ }))
    expect(panels()).toHaveLength(1)
    const visibleTab = screen.getByRole('tab', { name: /cc_data/ })
    expect(visibleTab).toHaveAttribute('aria-selected', 'true')
    // The directory's visible badge follows the temporary Focus: only the
    // panel actually on screen counts as 当前可见.
    expect(
      within(directory).getByRole('button', { name: /^cc_data/ })
    ).toHaveTextContent('当前可见')
    expect(
      within(directory).getByRole('button', { name: /^cc_sql/ })
    ).not.toHaveTextContent('当前可见')
  })

  it('exits Focus with Escape even when focus is inside the directory', async () => {
    const { user } = await gotoAgentsSurface()
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_sql' })
    )
    await user.click(
      within(panels()[1]).getByRole('button', { name: 'Focus 此 Panel' })
    )
    expect(panels()).toHaveLength(1)

    // The directory is a sibling of the workspace: Escape there must still
    // exit Focus — the user should not have to Tab back to the exit button.
    await user.click(within(directory).getByRole('textbox', { name: '搜索 Agent' }))
    await user.keyboard('{Escape}')
    expect(panels()).toHaveLength(2)
    expect(screen.getAllByRole('tab', { name: /cc_sql/ })).toHaveLength(1)
  })

  it('falls back to the newly focused panel when the focused panel is pruned', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_sql' })
    )
    await user.click(
      within(panels()[1]).getByRole('button', { name: 'Focus 此 Panel' })
    )

    // Closing the focused panel's only tab prunes it and auto-exits Focus;
    // the original trigger button no longer exists.
    await user.click(screen.getByRole('button', { name: '关闭标签 cc_sql' }))
    expect(panels()).toHaveLength(1)
    expect(document.activeElement).toBe(
      within(panels()[0]).getByRole('button', { name: 'Focus 此 Panel' })
    )
  })
})

// ---------------------------------------------------------------------------
// Analysis preset — one main + two auxiliary panels
// ---------------------------------------------------------------------------

describe('Workspace layout — Analysis preset', () => {
  it('builds the one-main-two-auxiliary tree from a single panel', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      within(panels()[0]).getByRole('button', { name: 'Analysis 预设' })
    )

    expect(panels()).toHaveLength(3)
    // The main panel keeps its tab; the two auxiliaries start empty.
    within(panels()[0]).getByRole('tab', { name: /cc_data/ })
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    // Plain split tree: horizontal main at 61%, auxiliaries stacked at 52%.
    const separators = screen.getAllByRole('separator', {
      name: '调整分割比例'
    })
    expect(separators).toHaveLength(2)
    expect(separators[0]).toHaveAttribute('aria-valuenow', '61')
    expect(separators[1]).toHaveAttribute('aria-valuenow', '52')
  })

  it('keeps every tab exactly once when more than three panels collapse into the preset', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_sql' })
    )
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_etl' })
    )
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cx_review' })
    )
    expect(panels()).toHaveLength(4)

    // Apply the preset with cc_etl's panel as the main one.
    await user.click(
      within(panels()[2]).getByRole('button', { name: 'Analysis 预设' })
    )

    expect(panels()).toHaveLength(3)
    // No tab is lost or duplicated by the restructuring.
    for (const name of [/cc_data/, /cc_sql/, /cc_etl/, /cx_review/]) {
      expect(screen.getAllByRole('tab', { name })).toHaveLength(1)
    }
    // The leftover panel's tab migrated into the main panel.
    const mainTabs = within(panels()[0]).getAllByRole('tab')
    expect(mainTabs).toHaveLength(2)
    within(panels()[0]).getByRole('tab', { name: /cc_etl/ })
    within(panels()[0]).getByRole('tab', { name: /cx_review/ })
    // The first two other panels in tree order became the auxiliaries.
    within(panels()[1]).getByRole('tab', { name: /cc_data/ })
    within(panels()[2]).getByRole('tab', { name: /cc_sql/ })
  })
})

// ---------------------------------------------------------------------------
// Keyboard parity — same commands as pointer gestures
// ---------------------------------------------------------------------------

describe('Workspace layout — keyboard parity', () => {
  it('activates a tab with Enter after arrow-key navigation', async () => {
    const { user } = await gotoAgentsSurface()
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    // cc_sql is selected after opening; go back to cc_data first.
    const ccDataTab = screen.getByRole('tab', { name: /cc_data/ })
    await user.click(ccDataTab)

    // Roving tabindex: only the selected tab is in the tab order.
    const ccSqlTab = screen.getByRole('tab', { name: /cc_sql/ })
    expect(ccDataTab).toHaveAttribute('tabindex', '0')
    expect(ccSqlTab).toHaveAttribute('tabindex', '-1')

    ccDataTab.focus()
    fireEvent.keyDown(ccDataTab, { key: 'ArrowRight' })
    expect(ccSqlTab).toHaveFocus()
    // Arrow navigation moves focus only; Enter activates.
    expect(ccSqlTab).toHaveAttribute('aria-selected', 'false')
    fireEvent.keyDown(ccSqlTab, { key: 'Enter' })
    expect(ccSqlTab).toHaveAttribute('aria-selected', 'true')
  })

  it('moves a tab to the next panel with Ctrl+ArrowRight', async () => {
    const { user } = await gotoAgentsSurface()
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    expect(panels()).toHaveLength(2)

    const ccDataTab = screen.getByRole('tab', { name: /cc_data/ })
    ccDataTab.focus()
    fireEvent.keyDown(ccDataTab, { key: 'ArrowRight', ctrlKey: true })

    // The tab moved — never copied — into the sibling panel.
    expect(panels()).toHaveLength(2)
    expect(screen.getAllByRole('tab', { name: /cc_data/ })).toHaveLength(1)
    within(panels()[1]).getByRole('tab', { name: /cc_data/ })
    within(panels()[0]).getByRole('tab', { name: /cc_sql/ })
  })

  it('moves a tab back to the previous panel with Ctrl+ArrowLeft', async () => {
    const { user } = await gotoAgentsSurface()
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )

    const ccDataTab = screen.getByRole('tab', { name: /cc_data/ })
    ccDataTab.focus()
    fireEvent.keyDown(ccDataTab, { key: 'ArrowRight', ctrlKey: true })
    const movedTab = screen.getByRole('tab', { name: /cc_data/ })
    movedTab.focus()
    fireEvent.keyDown(movedTab, { key: 'ArrowLeft', ctrlKey: true })

    // Moving back empties the sibling panel, which is pruned: the tab is
    // home again, exactly once, next to cc_sql.
    expect(screen.getAllByRole('tab', { name: /cc_data/ })).toHaveLength(1)
    const home = panels()[panels().length - 1]
    within(home).getByRole('tab', { name: /cc_data/ })
    within(home).getByRole('tab', { name: /cc_sql/ })
  })

  it('split-moves a tab with Ctrl+Shift+ArrowRight, dispatching the same command as an edge drop', async () => {
    const port = new RecordingPort()
    await gotoAgentsSurface(port)

    const ccDataTab = screen.getByRole('tab', { name: /cc_data/ })
    ccDataTab.focus()
    fireEvent.keyDown(ccDataTab, {
      key: 'ArrowRight',
      ctrlKey: true,
      shiftKey: true
    })

    expect(panels()).toHaveLength(2)
    within(panels()[1]).getByRole('tab', { name: /cc_data/ })
    // Exactly the operation a drop on the right edge produces.
    const layoutCommands = port.commands.filter(
      (c) => c.kind === 'change-layout'
    )
    expect(layoutCommands).toHaveLength(1)
    expect(layoutCommands[0]).toMatchObject({
      operation: {
        kind: 'open-tab-in-new-panel',
        agentInstanceId: 'inst-cc-data',
        direction: 'horizontal',
        position: 'after',
        relativeToPanelId: 'panel-main'
      }
    })
  })

  it('split-moves a tab downward with Ctrl+Shift+ArrowDown', async () => {
    await gotoAgentsSurface()
    const ccDataTab = screen.getByRole('tab', { name: /cc_data/ })
    ccDataTab.focus()
    fireEvent.keyDown(ccDataTab, {
      key: 'ArrowDown',
      ctrlKey: true,
      shiftKey: true
    })

    expect(panels()).toHaveLength(2)
    within(panels()[1]).getByRole('tab', { name: /cc_data/ })
    expect(
      screen.getByRole('separator', { name: '调整分割比例' })
    ).toHaveAttribute('aria-orientation', 'horizontal')
  })

  it('advertises the keyboard shortcuts on the tab', async () => {
    await gotoAgentsSurface()
    const ccDataTab = screen.getByRole('tab', { name: /cc_data/ })
    expect(ccDataTab).toHaveAttribute(
      'aria-keyshortcuts',
      expect.stringContaining('Control+ArrowRight')
    )
  })

  it('targets the spatial neighbour with Ctrl+Arrow in a nested Analysis tree', async () => {
    const { user } = await gotoAgentsSurface()
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    // Analysis preset from the single panel: [ main | (aux1 / aux2) ].
    await user.click(
      within(panels()[0]).getByRole('button', { name: 'Analysis 预设' })
    )
    expect(panels()).toHaveLength(3)

    // Walk cc_sql through the tree: main →(right)→ aux1 →(down)→ aux2.
    const ccSqlTab = screen.getByRole('tab', { name: /cc_sql/ })
    ccSqlTab.focus()
    fireEvent.keyDown(ccSqlTab, { key: 'ArrowRight', ctrlKey: true })
    within(panels()[1]).getByRole('tab', { name: /cc_sql/ })

    // Moving the only tab out of aux1 prunes it: [ main | aux2 ] remains.
    const aux1Tab = within(panels()[1]).getByRole('tab', { name: /cc_sql/ })
    aux1Tab.focus()
    fireEvent.keyDown(aux1Tab, { key: 'ArrowDown', ctrlKey: true })
    expect(panels()).toHaveLength(2)
    within(panels()[1]).getByRole('tab', { name: /cc_sql/ })

    // Ctrl+ArrowLeft from the bottom-right auxiliary must cross into the
    // LEFT main panel — not step one slot up in depth-first order.
    const aux2Tab = within(panels()[1]).getByRole('tab', { name: /cc_sql/ })
    aux2Tab.focus()
    fireEvent.keyDown(aux2Tab, { key: 'ArrowLeft', ctrlKey: true })
    within(panels()[0]).getByRole('tab', { name: /cc_sql/ })
    expect(screen.getAllByRole('tab', { name: /cc_sql/ })).toHaveLength(1)
  })

  it('restores focus to the tab after moving it with Ctrl+Arrow', async () => {
    const { user } = await gotoAgentsSurface()
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )

    const ccSqlTab = screen.getByRole('tab', { name: /cc_sql/ })
    ccSqlTab.focus()
    fireEvent.keyDown(ccSqlTab, { key: 'ArrowRight', ctrlKey: true })

    const movedTab = within(panels()[1]).getByRole('tab', { name: /cc_sql/ })
    expect(document.activeElement).toBe(movedTab)
  })

  it('restores focus to the tab after split-moving it with Ctrl+Shift+Arrow', async () => {
    await gotoAgentsSurface()
    const ccDataTab = screen.getByRole('tab', { name: /cc_data/ })
    ccDataTab.focus()
    fireEvent.keyDown(ccDataTab, {
      key: 'ArrowRight',
      ctrlKey: true,
      shiftKey: true
    })

    const movedTab = within(panels()[1]).getByRole('tab', { name: /cc_data/ })
    expect(document.activeElement).toBe(movedTab)
  })

  it('targets the same-row neighbour with Ctrl+Arrow in a 2×2 tree', async () => {
    const { user } = await gotoAgentsSurface()
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    // Build 2×2: [ (A / B) | (C / D) ] — A holds both tabs, B/C/D empty.
    await user.click(within(panels()[0]).getByRole('button', { name: '向右分割' }))
    await user.click(within(panels()[0]).getByRole('button', { name: '向下分割' }))
    await user.click(within(panels()[2]).getByRole('button', { name: '向下分割' }))
    expect(panels()).toHaveLength(4)

    // Move cc_sql down into B, then right: the same-row neighbour is the
    // bottom-right panel D — not the top-right C a first-descent picks.
    const ccSqlTab = screen.getByRole('tab', { name: /cc_sql/ })
    ccSqlTab.focus()
    fireEvent.keyDown(ccSqlTab, { key: 'ArrowDown', ctrlKey: true })
    const bTab = within(panels()[1]).getByRole('tab', { name: /cc_sql/ })
    bTab.focus()
    fireEvent.keyDown(bTab, { key: 'ArrowRight', ctrlKey: true })

    expect(panels()).toHaveLength(3)
    within(panels()[2]).getByRole('tab', { name: /cc_sql/ })
    expect(
      within(panels()[1]).queryByRole('tab', { name: /cc_sql/ })
    ).toBeNull()
  })

  it('prefers the neighbour with the most shared edge in an asymmetric 2×2 tree', async () => {
    const { user } = await gotoAgentsSurface()
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await user.click(within(panels()[0]).getByRole('button', { name: '向右分割' }))
    await user.click(within(panels()[0]).getByRole('button', { name: '向下分割' }))
    await user.click(within(panels()[2]).getByRole('button', { name: '向下分割' }))
    expect(panels()).toHaveLength(4)

    // Left column 70/30, right column 20/80: from A (y[0,0.7]) the
    // bottom-right D shares y[0.2,0.7] while C only shares y[0,0.2].
    // Re-query after each keydown: every accepted resize bumps the
    // revision, so further commits from the stale element would reject.
    // (Vertical dividers grow with ArrowDown and shrink with ArrowUp.)
    const separators = () =>
      screen.getAllByRole('separator', { name: '调整分割比例' })
    for (let i = 0; i < 4; i++) {
      fireEvent.keyDown(separators()[0], { key: 'ArrowDown' })
    }
    for (let i = 0; i < 6; i++) {
      fireEvent.keyDown(separators()[2], { key: 'ArrowUp' })
    }

    const ccDataTab = screen.getByRole('tab', { name: /cc_data/ })
    ccDataTab.focus()
    fireEvent.keyDown(ccDataTab, { key: 'ArrowRight', ctrlKey: true })

    within(panels()[3]).getByRole('tab', { name: /cc_data/ })
    expect(
      within(panels()[2]).queryByRole('tab', { name: /cc_data/ })
    ).toBeNull()
  })

  it('restores focus after Ctrl+Arrow even when the snapshot event arrives late', async () => {
    const { user } = await gotoAgentsSurface(new DelayedEventPort())
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    // With a delayed-event port the render lags the command: wait for each
    // authoritative update to land, or the next command stale-rejects.
    await screen.findByRole('tab', { name: /cc_sql/ })
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    await waitFor(() => expect(panels()).toHaveLength(2))

    const ccSqlTab = screen.getByRole('tab', { name: /cc_sql/ })
    ccSqlTab.focus()
    fireEvent.keyDown(ccSqlTab, { key: 'ArrowRight', ctrlKey: true })
    const movedTab = await within(panels()[1]).findByRole('tab', {
      name: /cc_sql/
    })
    await waitFor(() => expect(document.activeElement).toBe(movedTab))
  })

  it('keeps the pending focus restore of a succeeded move when an overlapping follow-up stale-rejects', async () => {
    const { user } = await gotoAgentsSurface(new DelayedEventPort())
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await screen.findByRole('tab', { name: /cc_sql/ })
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    await waitFor(() => expect(panels()).toHaveLength(2))

    const ccSqlTab = screen.getByRole('tab', { name: /cc_sql/ })
    ccSqlTab.focus()
    // Two overlapping gestures on the still-mounted tab: the first will
    // succeed, the second (dispatched with the pre-event revision) must
    // stale-reject — without cancelling the first one's pending restore.
    fireEvent.keyDown(ccSqlTab, { key: 'ArrowRight', ctrlKey: true })
    fireEvent.keyDown(ccSqlTab, {
      key: 'ArrowDown',
      ctrlKey: true,
      shiftKey: true
    })

    const movedTab = await within(panels()[1]).findByRole('tab', {
      name: /cc_sql/
    })
    await waitFor(() => expect(document.activeElement).toBe(movedTab))
  })

  it('handles opaque IDs that break attribute selectors during keyboard moves and Focus exit', async () => {
    const adapter = new MockScenarioAdapter()
    const { user } = await gotoAgentsSurface(adapter)

    // Rewrite cc_data's instance ID and the panel's ID to values containing
    // a quote and a backslash — legal per the opaque-ID contract, fatal to
    // naive attribute selectors. (The mock's snapshot is only compile-time
    // private; no public API can mint such IDs.)
    const internals = adapter as unknown as { snapshot: WorkbenchViewModel }
    const snapshot = internals.snapshot
    const evilAgent = id('inst-cc"data', 'AgentInstanceId')
    const evilPanel = id('panel-main\\bad', 'PanelId')
    const mainPanelId = id('panel-main', 'PanelId')
    const agent = snapshot.agents.find(
      (a) => a.agentInstanceId === id('inst-cc-data', 'AgentInstanceId')
    )!
    agent.agentInstanceId = evilAgent
    const layout = snapshot.projects[0].layout
    layout.panels[evilPanel] = layout.panels[mainPanelId]
    layout.panels[evilPanel].tabs = [evilAgent]
    layout.panels[evilPanel].activeTabId = evilAgent
    delete layout.panels[mainPanelId]
    layout.root = { kind: 'panel', panelId: evilPanel }
    layout.focusedPanelId = evilPanel
    // Publish the mutated snapshot through a command, inside act so the
    // shell's state update actually flushes before assertions.
    await act(async () => {
      await adapter.dispatch({
        kind: 'navigate',
        commandId: id('cmd-evil-ids', 'CommandId'),
        expectedRevision: snapshot.revision,
        projectId: snapshot.projects[0].projectId,
        surface: 'agents'
      })
    })

    // Keyboard split-move rebuilds the evil-ID tab; focus restoration must
    // not crash on a selector — it must find the tab by its raw ID.
    const evilTab = await screen.findByRole('tab', { name: /cc_data/ })
    evilTab.focus()
    fireEvent.keyDown(evilTab, {
      key: 'ArrowRight',
      ctrlKey: true,
      shiftKey: true
    })
    const movedTab = within(panels()[1]).getByRole('tab', { name: /cc_data/ })
    await waitFor(() => expect(document.activeElement).toBe(movedTab))

    // Entering and exiting Focus must also restore focus by the raw panel
    // ID, not by an attribute selector.
    await user.click(
      within(panels()[0]).getByRole('button', { name: 'Focus 此 Panel' })
    )
    await user.click(screen.getByRole('button', { name: '退出 Focus' }))
    expect(document.activeElement).toBe(
      within(panels()[0]).getByRole('button', { name: 'Focus 此 Panel' })
    )
  })
})

// ---------------------------------------------------------------------------
// Density — 4+ panels stay usable with a non-blocking hint
// ---------------------------------------------------------------------------

describe('Workspace layout — density', () => {
  it('shows a non-blocking hint at four panels and keeps every panel operable', async () => {
    const { user } = await gotoAgentsSurface()
    expect(screen.queryByRole('note')).toBeNull()

    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_sql' })
    )
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_etl' })
    )
    expect(screen.queryByRole('note')).toBeNull()

    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cx_review' })
    )
    expect(panels()).toHaveLength(4)
    // The hint is informational only — all panels keep working.
    expect(screen.getByRole('note')).toHaveTextContent(/超出建议密度/)
    for (const name of [/cc_data/, /cc_sql/, /cc_etl/, /cx_review/]) {
      expect(screen.getAllByRole('tab', { name })).toHaveLength(1)
    }

    // A fifth panel is still allowed — density never blocks.
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 kimi_visual' })
    )
    expect(panels()).toHaveLength(5)

    // The hint is dismissible.
    await user.click(
      screen.getByRole('button', { name: '关闭密度提示' })
    )
    expect(screen.queryByRole('note')).toBeNull()
    expect(panels()).toHaveLength(5)
  })

  it('stays fully operable after the window shrinks below the default desktop size', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_sql' })
    )
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_etl' })
    )
    expect(panels()).toHaveLength(3)

    // Shrink below 1280×800 — layout state must survive the resize.
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 700
    })
    fireEvent(window, new Event('resize'))

    expect(panels()).toHaveLength(3)
    for (const name of [/cc_data/, /cc_sql/, /cc_etl/]) {
      expect(screen.getAllByRole('tab', { name })).toHaveLength(1)
    }

    // Layout commands keep working after the resize: split further,
    // then enter and exit Focus.
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cx_review' })
    )
    expect(panels()).toHaveLength(4)
    expect(screen.getByRole('note')).toHaveTextContent(/超出建议密度/)
    await user.click(
      within(panels()[1]).getByRole('button', { name: 'Focus 此 Panel' })
    )
    expect(panels()).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '退出 Focus' }))
    expect(panels()).toHaveLength(4)
  })
})
