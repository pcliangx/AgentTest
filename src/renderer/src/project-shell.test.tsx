// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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
    expect(region).toHaveTextContent('4')
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

  it('navigates to the Agents surface on click and shows placeholder', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: 'Agent' }))
    expect(await screen.findByText(/尚未实现/)).toBeVisible()
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
    newerSnap.projects[0].currentSurface = 'agents'
    port.emit({
      kind: 'view-model-updated',
      revision: 1,
      snapshot: newerSnap
    })

    // Now resolve the initial getSnapshot() with an older revision 0.
    const staleSnap = createStandardScenario()
    staleSnap.revision = 0
    port.resolveInitial(staleSnap)

    // The renderer must keep revision 1's state (agents surface), not
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

// ---------------------------------------------------------------------------
// Global surfaces
// ---------------------------------------------------------------------------

describe('ProjectShell — global surfaces', () => {
  it('shows global navigation entries in project view', async () => {
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    expect(screen.getByRole('button', { name: '连接' })).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Provider 健康' })
    ).toBeVisible()
    expect(screen.getByRole('button', { name: '全局设置' })).toBeVisible()
  })

  it('navigates to Connections showing multiple connections', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '连接' }))
    const region = await screen.findByRole('region', { name: '全局连接' })
    expect(region).toHaveTextContent('飞书 · 销售团队')
    expect(region).toHaveTextContent('已连接')
    expect(region).toHaveTextContent('飞书 · 产品团队')
    expect(region).toHaveTextContent('未连接')
    expect(region).toHaveTextContent('GitHub')
    expect(region).toHaveTextContent('错误')
  })

  it('navigates to Provider Health showing blocked provider', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: 'Provider 健康' }))
    const region = await screen.findByRole('region', {
      name: 'Provider 健康'
    })
    expect(region).toHaveTextContent('Claude Code')
    expect(region).toHaveTextContent('可用')
    expect(region).toHaveTextContent('Kimi Code')
    expect(region).toHaveTextContent('已阻断')
  })

  it('returns to project from global view preserving the surface', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    // Navigate to tasks first, then go to global, then return
    await user.click(screen.getByRole('button', { name: '任务' }))
    expect(await screen.findByText(/尚未实现/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByRole('region', { name: '全局连接' })
    await user.click(screen.getByRole('button', { name: /返回项目/ }))
    // Should return to tasks surface, not overview
    expect(await screen.findByText(/尚未实现/)).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Confirmation host
// ---------------------------------------------------------------------------

describe('ProjectShell — confirmation host', () => {
  it('shows confirmation modal with all fields when deleting a connection', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByRole('region', { name: '全局连接' })
    const deleteButtons = screen.getAllByRole('button', { name: '删除' })
    await user.click(deleteButtons[0])
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('删除连接')
    expect(dialog).toHaveTextContent('飞书 · 销售团队')
    expect(dialog).toHaveTextContent('不可恢复')
    expect(dialog).toHaveTextContent('二次确认')
  })

  it('confirms dangerous action and closes modal', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByRole('region', { name: '全局连接' })
    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: '确认' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('cancels confirmation via cancel button', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByRole('region', { name: '全局连接' })
    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('dismisses confirmation via Escape key', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByRole('region', { name: '全局连接' })
    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// No side effects — extended
// ---------------------------------------------------------------------------

describe('ProjectShell — no side effects (global + confirmation)', () => {
  it('does not call window.api during global navigation and confirmation', async () => {
    const apiSpy = vi.fn()
    Object.defineProperty(window, 'api', {
      value: apiSpy,
      writable: true,
      configurable: true
    })
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByRole('region', { name: '全局连接' })
    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: '取消' }))
    await user.click(screen.getByRole('button', { name: /返回项目/ }))
    expect(apiSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Empty project — global surfaces still accessible
// ---------------------------------------------------------------------------

describe('ProjectShell — empty project', () => {
  it('allows navigating between global surfaces with no projects', async () => {
    const inner = new MockScenarioAdapter()
    const strip = (snap: WorkbenchViewModel): WorkbenchViewModel => {
      const s = structuredClone(snap)
      s.projects = []
      s.activeProjectId = undefined
      return s
    }
    const emptyPort: WorkbenchPort = {
      async getSnapshot() {
        return strip(await inner.getSnapshot())
      },
      dispatch: (cmd) => inner.dispatch(cmd),
      subscribe(fn) {
        return inner.subscribe((event) => {
          if (event.kind === 'view-model-updated') {
            fn({ ...event, snapshot: strip(event.snapshot) })
          }
        })
      }
    }
    const user = userEvent.setup()
    render(<ProjectShell port={emptyPort} />)
    await screen.findByText('没有可用的 Project')
    // Navigate to Connections
    await user.click(screen.getByRole('button', { name: '连接' }))
    // Global nav must still be visible in global view
    expect(screen.getByRole('button', { name: 'Provider 健康' })).toBeVisible()
    // Navigate to Provider Health
    await user.click(screen.getByRole('button', { name: 'Provider 健康' }))
    expect(
      await screen.findByRole('region', { name: 'Provider 健康' })
    ).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Confirmation result — connection disappears
// ---------------------------------------------------------------------------

describe('ProjectShell — confirmation result', () => {
  it('removes the connection after confirming deletion', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByRole('region', { name: '全局连接' })
    expect(screen.getByText('飞书 · 销售团队')).toBeVisible()
    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: '确认' }))
    expect(screen.queryByText('飞书 · 销售团队')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Provider recovery
// ---------------------------------------------------------------------------

describe('ProjectShell — provider recovery', () => {
  it('recovers a blocked provider via the recovery button', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: 'Provider 健康' }))
    const region = await screen.findByRole('region', {
      name: 'Provider 健康'
    })
    expect(region).toHaveTextContent('已阻断')
    await user.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => {
      expect(screen.queryByText('已阻断')).not.toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Focus restoration
// ---------------------------------------------------------------------------

describe('ProjectShell — focus restoration', () => {
  it('restores focus to the trigger after cancel', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByRole('region', { name: '全局连接' })
    const deleteButton = screen.getAllByRole('button', { name: '删除' })[0]
    deleteButton.focus()
    expect(deleteButton).toHaveFocus()
    await user.click(deleteButton)
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(deleteButton).toHaveFocus()
  })

  it('keeps focus in content area, not header, after confirming deletion', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByRole('region', { name: '全局连接' })
    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: '确认' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Focus must NOT land on the header nav button
    const headerConnButton = screen.getByRole('button', { name: '连接' })
    expect(document.activeElement).not.toBe(headerConnButton)
    expect(document.activeElement).not.toBe(document.body)
  })

  it('marks the active global surface button with aria-current', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByRole('region', { name: '全局连接' })
    expect(
      screen.getByRole('button', { name: '连接' })
    ).toHaveAttribute('aria-current', 'page')
    expect(
      screen.getByRole('button', { name: 'Provider 健康' })
    ).not.toHaveAttribute('aria-current')
  })

  it('clears stale rejection error when opening a new confirmation', async () => {
    // Port that rejects all confirm-dangerous-action commands
    const inner = new MockScenarioAdapter()
    const port: WorkbenchPort = {
      async getSnapshot() {
        return inner.getSnapshot()
      },
      dispatch(cmd) {
        if (cmd.kind === 'confirm-dangerous-action') {
          return Promise.resolve({
            ok: false,
            commandId: cmd.commandId,
            reason: 'invalid-target' as const,
            latestRevision: 0,
            message: '确认 ID 已过期'
          })
        }
        return inner.dispatch(cmd)
      },
      subscribe(fn) {
        return inner.subscribe(fn)
      }
    }

    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByRole('region', { name: '全局连接' })

    // Open confirmation and confirm — fails
    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: '确认' }))
    expect(screen.getByText('确认 ID 已过期')).toBeVisible()

    // Cancel and open a new confirmation
    await user.click(screen.getByRole('button', { name: '取消' }))
    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    await screen.findByRole('dialog')

    // Stale error from previous confirmation must NOT appear
    expect(screen.queryByText('确认 ID 已过期')).not.toBeInTheDocument()
  })
})
