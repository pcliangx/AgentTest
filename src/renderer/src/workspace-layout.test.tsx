// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'
import type {
  CommandResult,
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
})

describe('Workspace layout — pruning and panel close', () => {
  it('prunes the panel when its last tab closes', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    expect(panels()).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: '关闭标签 cc_data' }))
    expect(panels()).toHaveLength(1)
    // The remaining panel is the split-created empty one.
    expect(screen.getByText('未选择 Agent')).toBeVisible()
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
