// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'
import { createStandardScenario } from './workbench/standard-scenario'
import type {
  CommandResult,
  WorkbenchCommand,
  WorkbenchEvent,
  WorkbenchPort,
  WorkbenchViewModel
} from './workbench/contract'

afterEach(() => cleanup())

/** Helper: wait for the shell to finish loading by finding the first nav button. */
function waitForLoad() {
  return screen.findByRole('button', { name: '概览' })
}

describe('ProjectShell — snapshot rendering', () => {
  it('renders the active project name as a heading', async () => {
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    const heading = await screen.findByRole('heading', {
      name: '销售数据分析',
      level: 2
    })
    expect(heading).toBeVisible()
  })

  it('shows root availability and repository readiness', async () => {
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    const region = await screen.findByRole('region', { name: '项目概览' })
    expect(region).toHaveTextContent('可用')
    expect(region).toHaveTextContent('已就绪')
  })

  it('shows the connection summary', async () => {
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    const region = await screen.findByRole('region', { name: '项目概览' })
    expect(region).toHaveTextContent(/飞书/)
  })

  it('shows agent, run and attention counts', async () => {
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    const region = await screen.findByRole('region', { name: '项目概览' })
    expect(region).toHaveTextContent('8')
    expect(region).toHaveTextContent('Agent')
  })

  it('renders recent activity entries', async () => {
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    const region = await screen.findByRole('region', { name: '项目概览' })
    expect(region).toHaveTextContent(/cc_data 开始清洗/)
  })
})

describe('ProjectShell — navigation', () => {
  const navLabels = [
    '概览',
    'Agent',
    '任务',
    '知识',
    '交接',
    '活动',
    '设置'
  ] as const

  it('renders all seven primary navigation items', async () => {
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    for (const label of navLabels) {
      expect(screen.getByRole('button', { name: label })).toBeVisible()
    }
  })

  it('navigates to the Agents surface and shows the Agent Directory', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: 'Agent' }))
    expect(
      await screen.findByRole('region', { name: 'Agent 目录' })
    ).toBeVisible()
  })

  it('navigates to the Activity surface and shows entries with Chinese kind labels', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '活动' }))
    const region = await screen.findByRole('region', { name: '活动' })
    expect(region).toHaveTextContent(/cc_data 开始清洗/)
    expect(region).toHaveTextContent('运行开始')
    expect(region).not.toHaveTextContent('run-started')
  })

  it('does not show the old Provider three-slot UI', async () => {
    const { container } = render(
      <ProjectShell port={new MockScenarioAdapter()} />
    )
    await waitForLoad()
    expect(container.textContent).not.toContain('@@claude')
    expect(container.textContent).not.toContain('@@codex')
    expect(container.textContent).not.toContain('@@kimi')
  })
})

describe('ProjectShell — no side effects', () => {
  it('does not call window.api during navigation and project switching', async () => {
    const apiSpy = vi.fn()
    Object.defineProperty(window, 'api', {
      value: apiSpy,
      writable: true,
      configurable: true
    })
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '任务' }))
    await user.click(screen.getByRole('button', { name: '活动' }))
    await user.click(screen.getByRole('button', { name: '概览' }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: '切换项目' }),
      '用户研究'
    )
    expect(apiSpy).not.toHaveBeenCalled()
  })
})

describe('ProjectShell — project switcher', () => {
  it('renders a select with both projects', async () => {
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    const select = await screen.findByRole('combobox', { name: '切换项目' })
    const options = within(select).getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(select).toHaveTextContent('销售数据分析')
    expect(select).toHaveTextContent('用户研究')
  })

  it('switches active project on selection', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await screen.findByRole('heading', { name: '销售数据分析', level: 2 })
    await user.selectOptions(
      screen.getByRole('combobox', { name: '切换项目' }),
      '用户研究'
    )
    expect(
      await screen.findByRole('heading', { name: '用户研究', level: 2 })
    ).toBeVisible()
  })

  it('preserves the target project surface when switching', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()

    // Navigate sales project to tasks
    await user.click(screen.getByRole('button', { name: '任务' }))
    expect(await screen.findByText(/尚未实现/)).toBeVisible()

    // Switch to 用户研究 — should show its own overview, not tasks
    await user.selectOptions(
      screen.getByRole('combobox', { name: '切换项目' }),
      '用户研究'
    )
    expect(
      await screen.findByRole('region', { name: '项目概览' })
    ).toBeVisible()

    // Switch back to sales — should still show tasks
    await user.selectOptions(
      screen.getByRole('combobox', { name: '切换项目' }),
      '销售数据分析'
    )
    expect(await screen.findByText(/尚未实现/)).toBeVisible()
  })
})

describe('ProjectShell — stale snapshot safety', () => {
  /**
   * A port where getSnapshot() is manually deferred so we can simulate
   * events arriving before or after the initial load response.
   */
  class DeferredPort implements WorkbenchPort {
    private listeners = new Set<(e: WorkbenchEvent) => void>()
    private resolveFn: ((snap: WorkbenchViewModel) => void) | null = null
    private promise = new Promise<WorkbenchViewModel>((resolve) => {
      this.resolveFn = resolve
    })

    async getSnapshot() {
      return this.promise
    }
    async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
      return { ok: true, commandId: command.commandId, acceptedRevision: 0 }
    }
    subscribe(listener: (e: WorkbenchEvent) => void) {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    }
    emit(event: WorkbenchEvent) {
      for (const fn of this.listeners) fn(event)
    }
    resolveInitial(snap: WorkbenchViewModel) {
      this.resolveFn!(snap)
    }
  }

  it('ignores a stale getSnapshot response when a newer event arrived first', async () => {
    const port = new DeferredPort()
    render(<ProjectShell port={port} />)

    // Simulate a view-model-updated event arriving at revision 1 before
    // the initial getSnapshot() promise resolves.
    const newerSnap = createStandardScenario()
    newerSnap.revision = 1
    newerSnap.projects[0].currentSurface = 'tasks'
    port.emit({
      kind: 'view-model-updated',
      revision: 1,
      snapshot: newerSnap
    })

    // Now resolve the initial getSnapshot() with an older revision 0.
    const staleSnap = createStandardScenario()
    staleSnap.revision = 0
    port.resolveInitial(staleSnap)

    // The renderer must keep revision 1's state (tasks surface), not
    // overwrite it with the stale revision 0 (overview surface).
    expect(await screen.findByText(/尚未实现/)).toBeVisible()
  })
})

describe('ProjectShell — command ID uniqueness', () => {
  it('generates unique command IDs across remounts with the same adapter', async () => {
    const adapter = new MockScenarioAdapter()
    const user = userEvent.setup()

    const { unmount } = render(<ProjectShell port={adapter} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '任务' }))
    expect(await screen.findByText(/尚未实现/)).toBeVisible()
    unmount()

    // Remount with the same adapter — new mount must not reuse old
    // command IDs from the idempotency cache.
    render(<ProjectShell port={adapter} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '活动' }))
    expect(
      await screen.findByRole('region', { name: '活动' })
    ).toBeVisible()
  })
})
