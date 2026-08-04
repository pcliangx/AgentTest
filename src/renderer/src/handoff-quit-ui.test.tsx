// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'
import { createStandardScenario } from './workbench/standard-scenario'
import { id } from './workbench/contract'
import type { WorkbenchViewModel } from './workbench/contract'

afterEach(() => cleanup())

function waitForLoad() {
  return screen.findByRole('button', { name: '概览' })
}

// ---------------------------------------------------------------------------
// #12 AC1 — Handoffs surface renders handoff data
// ---------------------------------------------------------------------------

describe('ProjectShell — Handoffs surface (#12 AC1)', () => {
  it('navigates to the Handoffs surface and shows handoff records', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '交接' }))

    const region = await screen.findByRole('region', { name: '交接' })
    // Sales project has the complete handoff from cc_data to cc_sql
    expect(region).toHaveTextContent('Q2 销售流水')
    expect(region).toHaveTextContent('cc_data')
    expect(region).toHaveTextContent('cc_sql')
  })

  it('shows completeness and validation status for each handoff', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '交接' }))

    const region = await screen.findByRole('region', { name: '交接' })
    // Complete handoff in sales project
    expect(region).toHaveTextContent('完整')
  })

  it('shows incomplete handoff with reason and recovery actions in research project', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    // Switch to research project
    await user.selectOptions(
      screen.getByRole('combobox', { name: '切换项目' }),
      'proj-research'
    )
    await user.click(screen.getByRole('button', { name: '交接' }))

    const region = await screen.findByRole('region', { name: '交接' })
    expect(region).toHaveTextContent('不完整')
    expect(region).toHaveTextContent('缺少验证结果')
    expect(region).toHaveTextContent('恢复动作')
  })

  it('shows base commit and artifacts for handoffs', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '交接' }))

    const region = await screen.findByRole('region', { name: '交接' })
    expect(region).toHaveTextContent('a1b2c3d')
    expect(region).toHaveTextContent('src/types.ts')
  })

  it('shows empty state when a project has no handoffs', async () => {
    const scenario = createStandardScenario()
    // Remove all handoffs from the sales project
    scenario.handoffs = scenario.handoffs.filter(
      (h) => h.projectId !== id('proj-sales', 'ProjectId')
    )
    // Also remove from research to make the test simpler — we only look at sales
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter(scenario)} />)
    await waitForLoad()
    // The default project is sales, which now has no handoffs
    await user.click(screen.getByRole('button', { name: '交接' }))

    const region = await screen.findByRole('region', { name: '交接' })
    expect(region).toHaveTextContent('暂无交接记录')
  })
})

// ---------------------------------------------------------------------------
// #12 AC3/AC4 — Quit preview and close-window difference
// ---------------------------------------------------------------------------

describe('ProjectShell — quit preview (#12 AC3/AC4)', () => {
  it('clicking 退出 opens a quit preview showing active Runs, Terminals and dirty agents', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()

    await user.click(screen.getByRole('button', { name: '退出' }))

    const dialog = await screen.findByRole('dialog', { name: '退出 Agent Squad HQ' })
    // Active Run visible
    expect(dialog).toHaveTextContent('cc_data')
    // Active Terminal visible
    expect(dialog).toHaveTextContent('cx_anti')
    // Dirty agent visible
    expect(dialog).toHaveTextContent('cc_sql')
  })

  it('wait-for-runs dismisses the preview and preserves background state', async () => {
    const user = userEvent.setup()
    const adapter = new MockScenarioAdapter()
    render(<ProjectShell port={adapter} />)
    await waitForLoad()

    await user.click(screen.getByRole('button', { name: '退出' }))
    await screen.findByRole('dialog', { name: '退出 Agent Squad HQ' })

    await user.click(screen.getByRole('button', { name: '等待 Run 完成' }))

    // Dialog dismissed
    await expect(
      screen.queryByRole('dialog', { name: '退出 Agent Squad HQ' })
    ).toBeNull()

    // Background state preserved — cc_data still in permission-requested
    const snap = await adapter.getSnapshot()
    const ccData = snap.agents.find((a) => a.name === 'cc_data')!
    expect(ccData.runtimeState).toBe('permission-requested')
  })

  it('force-quit provides an unblockable exit entry', async () => {
    const user = userEvent.setup()
    const adapter = new MockScenarioAdapter()
    render(<ProjectShell port={adapter} />)
    await waitForLoad()

    await user.click(screen.getByRole('button', { name: '退出' }))
    const dialog = await screen.findByRole('dialog', { name: '退出 Agent Squad HQ' })

    // Force-quit button is present
    const forceButton = within(dialog).getByRole('button', { name: '强制退出' })
    await user.click(forceButton)

    // Dialog dismissed
    await expect(
      screen.queryByRole('dialog', { name: '退出 Agent Squad HQ' })
    ).toBeNull()

    // Runs stopped
    const snap = await adapter.getSnapshot()
    const ccData = snap.agents.find((a) => a.name === 'cc_data')!
    expect(ccData.runtimeState).toBe('interrupted')
  })

  it('close-window does NOT show quit preview', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()

    // There is a "关闭窗口" button that does not trigger quit preview
    const closeBtn = screen.getByRole('button', { name: '关闭窗口' })
    await user.click(closeBtn)

    // No quit preview dialog appears
    expect(
      screen.queryByRole('dialog', { name: '退出 Agent Squad HQ' })
    ).toBeNull()
  })
})
