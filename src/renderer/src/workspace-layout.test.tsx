// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'
import { id } from './workbench/contract'
import type {
  AgentInstanceId,
  CommandResult,
  LayoutOperation,
  PanelId,
  SplitNodeId,
  WorkbenchCommand,
  WorkbenchPort
} from './workbench/contract'

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

/** jsdom has no layout; give every element a measurable size for drag math. */
function stubLayoutRects() {
  const original = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 100,
      width: 1000,
      height: 100,
      toJSON: () => ({})
    } as DOMRect
  }
  return () => {
    Element.prototype.getBoundingClientRect = original
  }
}

/** Flex-basis of the first child next to the named separator. */
function firstChildBasis(index = 0): string {
  const separator = screen.getAllByRole('separator', {
    name: '调整分割比例'
  })[index]
  return (separator.parentElement!.firstElementChild as HTMLElement).style
    .flexBasis
}

/**
 * jsdom has no PointerEvent constructor and fireEvent drops clientX for
 * generic pointer events — dispatch a MouseEvent of the pointer type so
 * coordinates and pointerId reach the handlers.
 */
function firePointer(
  el: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  clientX: number,
  pointerId = 1
) {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX
  })
  Object.assign(event, { pointerId })
  fireEvent(el, event)
}

/**
 * Raw dispatch WITHOUT act(): React must not flush the queued snapshot
 * update between the authoritative port event and the gesture end — that
 * gap is exactly the same-batch race these tests reproduce.
 */
function dispatchPointerRaw(
  el: Element,
  type: 'pointermove' | 'pointerup',
  clientX: number,
  pointerId = 1
) {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX
  })
  Object.assign(event, { pointerId })
  el.dispatchEvent(event)
}

/**
 * Applies an authoritative layout change straight through the port,
 * bypassing the UI. The mock adapter dispatches synchronously, so the
 * subscribed shell updates its revision ref immediately while React stays
 * on the old render.
 */
let directCommandCount = 0
async function directLayout(
  port: WorkbenchPort,
  operation: LayoutOperation
): Promise<CommandResult> {
  const snap = await port.getSnapshot()
  return port.dispatch({
    kind: 'change-layout',
    commandId: id(`cmd-direct-${++directCommandCount}`, 'CommandId'),
    expectedRevision: snap.revision,
    projectId: id('proj-sales', 'ProjectId'),
    operation
  })
}

/** Raw drop dispatch with a dataTransfer payload (no act — see above). */
function dispatchDropRaw(el: Element, dataTransfer: unknown) {
  const event = new window.MouseEvent('drop', {
    bubbles: true,
    cancelable: true
  })
  Object.assign(event, { dataTransfer })
  el.dispatchEvent(event)
}

/** Raw mouse click without act (same-batch race reproduction). */
function dispatchClickRaw(el: Element) {
  el.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true })
  )
}

/** Drags a tab and drops it onto the named drop zone of a panel. */
function dragTabTo(tabName: RegExp, panel: HTMLElement, zoneName: string) {
  const dataTransfer = {
    data: {} as Record<string, string>,
    setData(type: string, value: string) {
      this.data[type] = value
    },
    getData(type: string) {
      return this.data[type]
    }
  }
  fireEvent.dragStart(screen.getByRole('tab', { name: tabName }), {
    dataTransfer
  })
  fireEvent.drop(within(panel).getByLabelText(zoneName), { dataTransfer })
  fireEvent.dragEnd(screen.getByRole('tab', { name: tabName }), {
    dataTransfer
  })
}

describe('Workspace layout — split', () => {
  it('splits a panel right and then down through the panel toolbar', async () => {
    const { user } = await gotoAgentsSurface()
    expect(panels()).toHaveLength(1)

    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    expect(panels()).toHaveLength(2)

    await user.click(
      within(panels()[1]).getByRole('button', { name: '向下分割' })
    )
    expect(panels()).toHaveLength(3)
  })

  it('opens an agent in a new panel from the directory without duplicating its tab', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_sql' })
    )
    expect(panels()).toHaveLength(2)
    const tabs = screen.getAllByRole('tab', { name: /cc_sql/ })
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
  })
})

describe('Workspace layout — drag and drop', () => {
  it('moves a tab to another panel center without copying it', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    expect(panels()).toHaveLength(2)

    dragTabTo(/cc_data/, panels()[1], '移动到该 Panel')

    const tabs = screen.getAllByRole('tab', { name: /cc_data/ })
    expect(tabs).toHaveLength(1)
    // cc_data now lives in the second panel; the first was pruned as empty.
    expect(panels()).toHaveLength(1)
    expect(
      within(panels()[0]).getByRole('tab', { name: /cc_data/ })
    ).toBeDefined()
  })

  it('creates a new split by dropping a tab on a panel edge', async () => {
    await gotoAgentsSurface()
    dragTabTo(/cc_data/, panels()[0], '拖到右侧分屏')

    expect(panels()).toHaveLength(2)
    expect(
      within(panels()[1]).getByRole('tab', { name: /cc_data/ })
    ).toBeDefined()
    expect(screen.getAllByRole('tab', { name: /cc_data/ })).toHaveLength(1)
  })

  it('clears the drag state after a successful drop, even when the old source node is gone', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    // Save the source tab node BEFORE the drop — the accepted move
    // unmounts it, and a dragend dispatched to a detached node can never
    // bubble up to the React root.
    const sourceTab = screen.getByRole('tab', { name: /cc_data/ })
    const dataTransfer = {
      data: {} as Record<string, string>,
      setData(type: string, value: string) {
        this.data[type] = value
      },
      getData(type: string) {
        return this.data[type]
      }
    }
    fireEvent.dragStart(sourceTab, { dataTransfer })
    fireEvent.drop(within(panels()[1]).getByLabelText('移动到该 Panel'), {
      dataTransfer
    })

    expect(sourceTab.isConnected).toBe(false)
    fireEvent.dragEnd(sourceTab, { dataTransfer })
    // Drop zones must be gone anyway — no ghost overlay intercepting
    // subsequent panel interactions.
    expect(screen.queryByLabelText('移动到该 Panel')).toBeNull()
    expect(screen.queryByLabelText('拖到右侧分屏')).toBeNull()
  })
})

describe('Workspace layout — divider', () => {
  it('adjusts the ratio via keyboard and commits immediately', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    const separator = screen.getByRole('separator', { name: '调整分割比例' })
    const firstChild = separator.parentElement!.firstElementChild as HTMLElement
    expect(firstChild.style.flexBasis).toBe('50%')

    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(
      (screen.getByRole('separator', { name: '调整分割比例' })
        .parentElement!.firstElementChild as HTMLElement).style.flexBasis
    ).toBe('55%')
  })

  it('discards the preview and shows a recoverable notice when a resize is rejected', async () => {
    // A port that rejects the first resize-split as stale.
    class StaleResizePort implements WorkbenchPort {
      private inner = new MockScenarioAdapter()
      private rejected = false
      getSnapshot() {
        return this.inner.getSnapshot()
      }
      planDispatch: WorkbenchPort['planDispatch'] = (request) =>
        this.inner.planDispatch(request)
      subscribe(listener: Parameters<WorkbenchPort['subscribe']>[0]) {
        return this.inner.subscribe(listener)
      }
      async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
        if (
          command.kind === 'change-layout' &&
          command.operation.kind === 'resize-split' &&
          !this.rejected
        ) {
          this.rejected = true
          const latest = await this.inner.getSnapshot()
          return {
            ok: false,
            commandId: command.commandId,
            reason: 'stale-revision',
            latestRevision: latest.revision,
            message: 'revision 已过期'
          }
        }
        return this.inner.dispatch(command)
      }
    }

    const { user } = await gotoAgentsSurface(new StaleResizePort())
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )

    const separator = screen.getByRole('separator', { name: '调整分割比例' })
    fireEvent.keyDown(separator, { key: 'ArrowRight' })

    // Ratio reverted to the authoritative 50% and a recoverable notice shows.
    expect(
      (screen.getByRole('separator', { name: '调整分割比例' })
        .parentElement!.firstElementChild as HTMLElement).style.flexBasis
    ).toBe('50%')
    expect(await screen.findByRole('status')).toHaveTextContent(/已恢复/)
  })

  it('clears the preview without committing when a divider drag is cancelled', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    const separator = screen.getByRole('separator', { name: '调整分割比例' })

    const restore = stubLayoutRects()
    try {
      firePointer(separator, 'pointerdown', 500)
      firePointer(separator, 'pointermove', 600)
      expect(firstChildBasis()).toBe('60%')

      firePointer(separator, 'pointercancel', 600)
      // Preview discarded, authoritative ratio kept, nothing committed.
      expect(firstChildBasis()).toBe('50%')
    } finally {
      restore()
    }
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('cancels an in-flight divider drag when the authoritative revision changes', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    const separator = screen.getByRole('separator', { name: '调整分割比例' })

    const restore = stubLayoutRects()
    try {
      firePointer(separator, 'pointerdown', 500)
      // An authoritative layout change arrives mid-gesture.
      await user.click(
        within(panels()[1]).getByRole('button', { name: '向下分割' })
      )
      const rootSeparator = screen.getAllByRole('separator', {
        name: '调整分割比例'
      })[0]
      firePointer(rootSeparator, 'pointermove', 600)
      firePointer(rootSeparator, 'pointerup', 600)
      // The stale-baseline drag must not commit over the newer snapshot:
      // the original split keeps its authoritative 50% ratio.
      expect(firstChildBasis()).toBe('50%')
    } finally {
      restore()
    }
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('rejects a pointer commit whose baseline revision went stale in the same batch', async () => {
    const port = new MockScenarioAdapter()
    const { user } = await gotoAgentsSurface(port)
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    const separator = screen.getByRole('separator', { name: '调整分割比例' })
    const root = (await port.getSnapshot()).projects[0].layout.root
    if (root?.kind !== 'split') throw new Error('expected split root')

    const restore = stubLayoutRects()
    try {
      firePointer(separator, 'pointerdown', 500)
      // The authoritative event updates the shell's revision ref
      // synchronously, but React has not re-rendered yet — the gesture
      // ends on the stale render, inside the same batch.
      await directLayout(port, {
        kind: 'resize-split',
        splitNodeId: root.splitNodeId,
        ratio: 0.8
      })
      dispatchPointerRaw(separator, 'pointermove', 600)
      dispatchPointerRaw(separator, 'pointerup', 600)

      // The 0.5→0.6 commit based on the stale render must be rejected as
      // stale — never overwrite the authoritative 0.8.
      expect(await screen.findByRole('status')).toHaveTextContent(/已恢复/)
      expect(firstChildBasis()).toBe('80%')
    } finally {
      restore()
    }
  })

  it('rejects a keyboard commit from a stale render in the same batch', async () => {
    const port = new MockScenarioAdapter()
    const { user } = await gotoAgentsSurface(port)
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    const separator = screen.getByRole('separator', { name: '调整分割比例' })
    const root = (await port.getSnapshot()).projects[0].layout.root
    if (root?.kind !== 'split') throw new Error('expected split root')

    await directLayout(port, {
      kind: 'resize-split',
      splitNodeId: root.splitNodeId,
      ratio: 0.8
    })
    // Raw dispatch: the keydown handler still sees the pre-event render.
    separator.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true
      })
    )

    // The 0.5→0.55 commit must be rejected as stale, with a notice.
    expect(await screen.findByRole('status')).toHaveTextContent(/已恢复/)
    expect(firstChildBasis()).toBe('80%')
  })
})

describe('Workspace layout — pruning and panel close', () => {
  it('prunes an emptied panel while other tabs remain', async () => {
    const { user } = await gotoAgentsSurface()
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    expect(panels()).toHaveLength(2)
    dragTabTo(/cc_sql/, panels()[1], '移动到该 Panel')

    // Closing cc_sql empties its panel: it is pruned and cc_data's panel
    // fills the space; other tabs keep the workspace alive.
    await user.click(screen.getByRole('button', { name: '关闭标签 cc_sql' }))
    expect(panels()).toHaveLength(1)
    expect(
      within(panels()[0]).getByRole('tab', { name: /cc_data/ })
    ).toBeDefined()
  })

  it('shows the empty workspace when the globally last tab closes', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    expect(panels()).toHaveLength(2)

    // UX-v0.2 §7.2(5) / ADR-0009: all tabs closed → empty workspace,
    // no orphaned empty panel left behind.
    await user.click(screen.getByRole('button', { name: '关闭标签 cc_data' }))
    expect(
      screen.queryAllByRole('group', { name: 'Agent 面板' })
    ).toHaveLength(0)
    expect(await screen.findByText(/尚未打开任何 Agent/)).toBeVisible()
  })

  it('closes an empty panel directly', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    await user.click(
      within(panels()[1]).getByRole('button', { name: '关闭 Panel' })
    )
    expect(panels()).toHaveLength(1)
  })

  it('requires a migration target before closing a panel with tabs', async () => {
    const { user } = await gotoAgentsSurface()
    // Open a second tab in the original panel.
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    expect(panels()).toHaveLength(2)

    await user.click(
      within(panels()[0]).getByRole('button', { name: '关闭 Panel' })
    )
    const dialog = await screen.findByRole('dialog', { name: '关闭 Panel' })
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: '迁移目标 Panel' }),
      '空 Panel'
    )
    await user.click(within(dialog).getByRole('button', { name: '迁移并关闭' }))

    expect(panels()).toHaveLength(1)
    expect(screen.getByRole('tab', { name: /cc_data/ })).toBeDefined()
    expect(screen.getByRole('tab', { name: /cc_sql/ })).toBeDefined()
  })

  it('labels duplicate empty migration targets distinctly', async () => {
    const { user } = await gotoAgentsSurface()
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    // Two splits of the original panel → two empty sibling panels.
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    expect(panels()).toHaveLength(3)

    await user.click(
      within(panels()[0]).getByRole('button', { name: '关闭 Panel' })
    )
    const dialog = await screen.findByRole('dialog', { name: '关闭 Panel' })
    const options = within(dialog)
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options).toEqual(['空 Panel（1）', '空 Panel（2）'])

    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: '迁移目标 Panel' }),
      '空 Panel（2）'
    )
    await user.click(within(dialog).getByRole('button', { name: '迁移并关闭' }))

    expect(panels()).toHaveLength(2)
    expect(screen.getAllByRole('tab', { name: /cc_data/ })).toHaveLength(1)
    expect(screen.getAllByRole('tab', { name: /cc_sql/ })).toHaveLength(1)
  })
})

describe('Workspace layout — no lifecycle side effects', () => {
  it('keeps agent runtime state untouched through splits, moves and closes', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    dragTabTo(/cc_data/, panels()[1], '移动到该 Panel')
    await user.click(screen.getByRole('button', { name: '关闭标签 cc_data' }))

    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    expect(
      within(directory).getByRole('button', { name: /^cc_data/ })
    ).toHaveTextContent('运行中')
  })
})

describe('Workspace layout — rejection recovery', () => {
  it('shows a recoverable notice when opening in a new panel is rejected', async () => {
    // A port that rejects the first open-tab-in-new-panel as stale.
    class StaleOpenPort implements WorkbenchPort {
      private inner = new MockScenarioAdapter()
      private rejected = false
      getSnapshot() {
        return this.inner.getSnapshot()
      }
      planDispatch: WorkbenchPort['planDispatch'] = (request) =>
        this.inner.planDispatch(request)
      subscribe(listener: Parameters<WorkbenchPort['subscribe']>[0]) {
        return this.inner.subscribe(listener)
      }
      async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
        if (
          command.kind === 'change-layout' &&
          command.operation.kind === 'open-tab-in-new-panel' &&
          !this.rejected
        ) {
          this.rejected = true
          const latest = await this.inner.getSnapshot()
          return {
            ok: false,
            commandId: command.commandId,
            reason: 'stale-revision',
            latestRevision: latest.revision,
            message: 'revision 已过期'
          }
        }
        return this.inner.dispatch(command)
      }
    }

    const { user } = await gotoAgentsSurface(new StaleOpenPort())
    await user.click(
      screen.getByRole('button', { name: '在新 Panel 打开 cc_sql' })
    )

    expect(await screen.findByRole('status')).toHaveTextContent(/已恢复/)
    // Nothing opened: no new panel, no tab.
    expect(panels()).toHaveLength(1)
    expect(screen.queryByRole('tab', { name: /cc_sql/ })).toBeNull()
  })

  it('rejects a tab drop whose drag started before an authoritative move', async () => {
    const port = new MockScenarioAdapter()
    const { user } = await gotoAgentsSurface(port)
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    // Tree: [ main(cc_data, cc_sql) | sibling(empty) ].
    const snap = await port.getSnapshot()
    const siblingId = Object.keys(snap.projects[0].layout.panels).find(
      (p) => p !== 'panel-main'
    )!

    const dataTransfer = {
      data: {} as Record<string, string>,
      setData(type: string, value: string) {
        this.data[type] = value
      },
      getData(type: string) {
        return this.data[type]
      }
    }
    fireEvent.dragStart(screen.getByRole('tab', { name: /cc_sql/ }), {
      dataTransfer
    })
    // The authoritative move lands before React re-renders; the stale
    // drag then drops onto the old sibling's edge zone.
    await directLayout(port, {
      kind: 'move-tab',
      agentInstanceId: id('inst-cc-sql', 'AgentInstanceId'),
      targetPanelId: id(siblingId, 'PanelId')
    })
    dispatchDropRaw(
      within(panels()[1]).getByLabelText('拖到右侧分屏'),
      dataTransfer
    )
    fireEvent.dragEnd(screen.getByRole('tab', { name: /cc_sql/ }), {
      dataTransfer
    })

    // The stale drop must be rejected: recoverable notice, no third
    // panel, and the tab stays where the authoritative move put it.
    expect(await screen.findByRole('status')).toHaveTextContent(/已恢复/)
    expect(panels()).toHaveLength(2)
    expect(screen.getAllByRole('tab', { name: /cc_sql/ })).toHaveLength(1)
    expect(
      within(panels()[1]).getByRole('tab', { name: /cc_sql/ })
    ).toBeDefined()
  })

  it('rejects a stale close-panel confirmation when a tab landed meanwhile', async () => {
    const port = new MockScenarioAdapter()
    const { user } = await gotoAgentsSurface(port)
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    await user.click(
      within(panels()[0]).getByRole('button', { name: '关闭 Panel' })
    )
    const dialog = await screen.findByRole('dialog', { name: '关闭 Panel' })

    // A new tab authoritatively lands in the to-be-closed panel while the
    // user is looking at the stale dialog.
    await directLayout(port, {
      kind: 'open-tab',
      panelId: id('panel-main', 'PanelId'),
      agentInstanceId: id('inst-cc-etl', 'AgentInstanceId')
    })
    dispatchClickRaw(
      within(dialog).getByRole('button', { name: '迁移并关闭' })
    )

    // The stale confirmation must not dispose of the unseen tab: it is
    // rejected, the authoritative layout is restored and a notice shows.
    expect(await screen.findByRole('status')).toHaveTextContent(/已恢复/)
    expect(panels()).toHaveLength(2)
    expect(
      within(panels()[0]).getByRole('tab', { name: /cc_etl/ })
    ).toBeDefined()
  })

  it('closes the stale confirmation instead of re-baselining onto an unrendered revision', async () => {
    const port = new MockScenarioAdapter()
    const { user } = await gotoAgentsSurface(port)
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    await user.click(
      within(panels()[0]).getByRole('button', { name: '关闭 Panel' })
    )
    const dialog = await screen.findByRole('dialog', { name: '关闭 Panel' })

    await directLayout(port, {
      kind: 'open-tab',
      panelId: id('panel-main', 'PanelId'),
      agentInstanceId: id('inst-cc-etl', 'AgentInstanceId')
    })
    dispatchClickRaw(
      within(dialog).getByRole('button', { name: '迁移并关闭' })
    )
    expect(await screen.findByRole('status')).toHaveTextContent(/已恢复/)

    // After a stale rejection the dialog must be gone: the rejection
    // response may arrive BEFORE the refreshed snapshot is rendered, so a
    // still-open dialog could be re-confirmed against a revision the user
    // has never seen. Re-opening rebuilds candidates from the latest
    // rendered layout instead.
    expect(screen.queryByRole('dialog', { name: '关闭 Panel' })).toBeNull()
    expect(panels()).toHaveLength(2)
    expect(
      within(panels()[0]).getByRole('tab', { name: /cc_etl/ })
    ).toBeDefined()
  })

  it('rejects a discrete layout command issued from a stale render', async () => {
    const port = new MockScenarioAdapter()
    const { user } = await gotoAgentsSurface(port)
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    const root = (await port.getSnapshot()).projects[0].layout.root
    if (root?.kind !== 'split') throw new Error('expected split root')

    // cc_data is the inactive tab; the click handler belongs to the
    // pre-event render.
    const staleTab = screen.getByRole('tab', { name: /cc_data/ })
    await directLayout(port, {
      kind: 'resize-split',
      splitNodeId: root.splitNodeId,
      ratio: 0.8
    })
    dispatchClickRaw(staleTab)

    expect(await screen.findByRole('status')).toHaveTextContent(/已恢复/)
    expect(screen.getByRole('tab', { name: /cc_data/ })).toHaveAttribute(
      'aria-selected',
      'false'
    )
  })
})

// ---------------------------------------------------------------------------
// Queue panel and Terminal takeover (#7)
// ---------------------------------------------------------------------------

describe('Workspace layout — queue and terminal (#7)', () => {
  /** Navigate to Agents surface; cc_data is open by default in the scenario. */
  async function gotoAgentView() {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await screen.findByRole('button', { name: '概览' })
    await user.click(screen.getByRole('button', { name: 'Agent' }))
    await screen.findByRole('region', { name: 'Agent 目录' })
    // cc_data is open by default — its Agent View should be visible
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    return { user, view }
  }

  it('shows queue panel with depth when project has queued items', async () => {
    const { view } = await gotoAgentView()
    const queue = screen.getByRole('region', { name: '队列' })
    expect(queue).toHaveTextContent('队列深度：2')
  })

  it('canceling a queue item removes it from the list', async () => {
    const { user } = await gotoAgentView()
    expect(screen.getByText('队列深度：2')).toBeVisible()
    const cancelButtons = screen.getAllByRole('button', { name: '取消排队' })
    await user.click(cancelButtons[0])
    await waitFor(() => {
      expect(screen.getByText('队列深度：1')).toBeVisible()
    })
  })

  it('terminal sub-view shows takeover blocked for running agent', async () => {
    const { user, view } = await gotoAgentView()
    await user.click(within(view).getByRole('button', { name: 'Terminal' }))
    expect(view).toHaveTextContent('Terminal 未接管')
    // cc_data is running — open button should be disabled
    expect(
      within(view).getByRole('button', { name: '打开 Terminal' })
    ).toBeDisabled()
  })

  it('terminal sub-view allows open for a ready agent (cx_review)', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await screen.findByRole('button', { name: '概览' })
    await user.click(screen.getByRole('button', { name: 'Agent' }))
    await screen.findByRole('region', { name: 'Agent 目录' })
    // Open cx_review in the current panel
    await user.click(screen.getByRole('button', { name: /^cx_review/ }))
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: 'Terminal' }))
    const openBtn = within(view).getByRole('button', { name: '打开 Terminal' })
    expect(openBtn).not.toBeDisabled()
    await user.click(openBtn)
    // After opening, should show "结束接管" button
    expect(
      await screen.findByRole('button', { name: '结束接管' })
    ).toBeVisible()
  })

  it('does not call window.api during queue and terminal interactions', async () => {
    const apiSpy = vi.fn()
    Object.defineProperty(window, 'api', {
      value: apiSpy,
      writable: true,
      configurable: true
    })
    const { user } = await gotoAgentView()
    const cancelButtons = screen.getAllByRole('button', { name: '取消排队' })
    await user.click(cancelButtons[0])
    expect(apiSpy).not.toHaveBeenCalled()
  })
})
