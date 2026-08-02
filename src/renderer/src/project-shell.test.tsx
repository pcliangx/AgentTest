// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'

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

  it('navigates to the Activity surface and shows entries', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await waitForLoad()
    await user.click(screen.getByRole('button', { name: '活动' }))
    const region = await screen.findByRole('region', { name: '活动' })
    expect(region).toHaveTextContent(/cc_data 开始清洗/)
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
  it('does not call window.api during navigation', async () => {
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
    expect(apiSpy).not.toHaveBeenCalled()
  })
})
