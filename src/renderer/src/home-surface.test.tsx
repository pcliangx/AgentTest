// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'
import { createStandardScenario } from './workbench/standard-scenario'
import type { WorkbenchViewModel } from './workbench/contract'

/**
 * The App-level home page (#76): startup landing, quick project creation,
 * recent-project direct access and the two-tier left navigation. Tests
 * drive the shell through the MockScenarioAdapter and observe accessible
 * roles and port-produced ViewModels.
 */

afterEach(() => cleanup())

async function renderShell(scenario?: WorkbenchViewModel) {
  const user = userEvent.setup()
  render(
    <ProjectShell port={new MockScenarioAdapter(scenario ?? createStandardScenario())} />
  )
  const home = await screen.findByRole('region', { name: '首页' })
  return { user, home }
}

/** The rail's App tier (#76) — the global entries' home since they left the header. */
function appTier() {
  return within(screen.getByRole('navigation', { name: '主导航' })).getByRole(
    'group',
    { name: 'App 级' }
  )
}

function switchBar() {
  return screen.getByRole('navigation', { name: '快捷切换' })
}

describe('Home — startup landing (#76)', () => {
  it('lands on the home page with the quick-create area and recent projects', async () => {
    const { home } = await renderShell()
    expect(
      within(home).getByRole('heading', { name: 'Agent Squad HQ' })
    ).toBeVisible()
    expect(within(home).getByLabelText('项目名称')).toBeVisible()
    expect(within(home).getByLabelText('根目录')).toBeVisible()
    expect(
      within(home).getByRole('button', { name: '创建并进入' })
    ).toBeVisible()
    // No project is current while a global work surface is active.
    for (const button of within(switchBar()).getAllByRole('button')) {
      expect(button).not.toHaveAttribute('aria-current')
    }
    // 首页 itself carries the current marker in the App tier.
    expect(
      within(appTier()).getByRole('button', { name: '首页' })
    ).toHaveAttribute('aria-current', 'page')
  })

  it('shows the recent projects with name, root path and last-opened time, most recent first', async () => {
    const { home } = await renderShell()
    const list = within(home).getByRole('list', { name: '最近项目' })
    // #88: each row has an open button (no aria-label, name = project name)
    // plus a ⚙ settings quick action — count the open buttons.
    const rows = within(list)
      .getAllByRole('button')
      .filter((b) => !b.getAttribute('aria-label')?.startsWith('设置'))
    expect(rows).toHaveLength(2)
    // 销售数据分析 opened 1h ago, 用户研究 1d ago.
    expect(rows[0]).toHaveTextContent('销售数据分析')
    expect(rows[0]).toHaveTextContent('~/Projects/sales-analysis')
    expect(rows[1]).toHaveTextContent('用户研究')
    expect(rows[1]).toHaveTextContent('~/Projects/user-research')
    // Both rows show a formatted last-opened time, never a bare timestamp.
    expect(rows[0].closest('li')?.querySelector('time')?.textContent).toBeTruthy()
    expect(rows[0]).not.toHaveTextContent(/\d{13}/)
  })

  it('enters a project from its recent row, landing on its own surface', async () => {
    const { user, home } = await renderShell()
    const list = within(home).getByRole('list', { name: '最近项目' })
    await user.click(
      within(list).getByRole('button', { name: /^用户研究/ })
    )
    expect(
      await screen.findByRole('heading', { name: '用户研究', level: 2 })
    ).toBeVisible()
    expect(
      within(switchBar()).getByRole('button', { name: '用户研究' })
    ).toHaveAttribute('aria-current', 'page')
  })

  it('is one click away from any surface via the App tier', async () => {
    const { user } = await renderShell()
    // Enter a project, then bounce straight back home.
    await user.click(
      within(switchBar()).getByRole('button', { name: '销售数据分析' })
    )
    await screen.findByRole('region', { name: '项目概览' })
    await user.click(within(appTier()).getByRole('button', { name: '首页' }))
    expect(
      await screen.findByRole('region', { name: '首页' })
    ).toBeVisible()
  })
})

describe('Home — quick create (#76)', () => {
  it('creates a project and lands directly inside it', async () => {
    const { user } = await renderShell()
    await user.type(screen.getByLabelText('项目名称'), '增长实验平台')
    await user.type(screen.getByLabelText('根目录'), '~/Projects/growth-lab')
    await user.click(screen.getByRole('button', { name: '创建并进入' }))

    // Straight into the new project's Overview.
    expect(
      await screen.findByRole('heading', { name: '增长实验平台', level: 2 })
    ).toBeVisible()
    expect(
      within(switchBar()).getByRole('button', { name: '增长实验平台' })
    ).toHaveAttribute('aria-current', 'page')
    // The demo flow validated no Git repository — the status card says so.
    expect(
      screen.getByRole('region', { name: '项目概览' })
    ).toHaveTextContent('未就绪')
  })

  it('lists the created project on top of 最近项目', async () => {
    const { user, home } = await renderShell()
    await user.type(within(home).getByLabelText('项目名称'), '增长实验平台')
    await user.type(within(home).getByLabelText('根目录'), '~/Projects/growth-lab')
    await user.click(
      within(home).getByRole('button', { name: '创建并进入' })
    )
    await screen.findByRole('heading', { name: '增长实验平台', level: 2 })

    await user.click(within(appTier()).getByRole('button', { name: '首页' }))
    const nextHome = await screen.findByRole('region', { name: '首页' })
    const rows = within(
      within(nextHome).getByRole('list', { name: '最近项目' })
    )
      .getAllByRole('button')
      .filter((b) => !b.getAttribute('aria-label')?.startsWith('设置'))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('增长实验平台')
    expect(rows[0]).toHaveTextContent('~/Projects/growth-lab')
  })

  it('keeps the create button disabled until both name and root path are given', async () => {
    const { user, home } = await renderShell()
    const submit = within(home).getByRole('button', { name: '创建并进入' })
    expect(submit).toBeDisabled()
    // Whitespace-only name does not count.
    await user.type(within(home).getByLabelText('项目名称'), '  ')
    expect(submit).toBeDisabled()
    // A real name alone is not enough — 根目录 is also required (#76 spec).
    await user.clear(within(home).getByLabelText('项目名称'))
    await user.type(within(home).getByLabelText('项目名称'), '增长实验平台')
    expect(submit).toBeDisabled()
    await user.type(within(home).getByLabelText('根目录'), '~/Projects/growth-lab')
    expect(submit).toBeEnabled()
  })
})

describe('Home — empty state (#76)', () => {
  it('makes the create area the main body when no projects exist', async () => {
    // An empty starting scenario — created projects flow through naturally.
    const scenario = createStandardScenario()
    scenario.projects = []
    scenario.activeProjectId = undefined
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter(scenario)} />)
    const home = await screen.findByRole('region', { name: '首页' })
    expect(within(home).getByLabelText('项目名称')).toBeVisible()
    expect(
      within(home).queryByRole('list', { name: '最近项目' })
    ).not.toBeInTheDocument()

    // Creating the very first project still lands straight inside it.
    await user.type(within(home).getByLabelText('项目名称'), '第一个项目')
    await user.type(within(home).getByLabelText('根目录'), '~/Projects/first')
    await user.click(
      within(home).getByRole('button', { name: '创建并进入' })
    )
    expect(
      await screen.findByRole('heading', { name: '第一个项目', level: 2 })
    ).toBeVisible()
  })
})

describe('Left navigation — two tiers (#76)', () => {
  it('places the App-level entries above the seven project surfaces', async () => {
    await renderShell()
    for (const label of ['首页', '连接', 'Provider 健康', '全局设置']) {
      expect(
        within(appTier()).getByRole('button', { name: label })
      ).toBeVisible()
    }
    const projectTier = within(
      screen.getByRole('navigation', { name: '主导航' })
    ).getByRole('group', { name: '项目工作面' })
    for (const label of [
      '概览',
      'Agent',
      '任务',
      '知识',
      '交接',
      '活动',
      '设置'
    ]) {
      expect(
        within(projectTier).getByRole('button', { name: label })
      ).toBeVisible()
    }
    // #92: the unified header no longer hosts the global entries — they
    // live exclusively in the left navigation's App tier.
    const header = document.querySelector('header.titlebar')!
    expect(
      within(header).queryByRole('button', { name: '连接' })
    ).not.toBeInTheDocument()
  })

  it('navigates to the global surfaces from the App tier', async () => {
    const { user } = await renderShell()
    await user.click(within(appTier()).getByRole('button', { name: '连接' }))
    expect(
      await screen.findByRole('region', { name: '全局连接' })
    ).toBeVisible()
    expect(
      within(appTier()).getByRole('button', { name: '连接' })
    ).toHaveAttribute('aria-current', 'page')
  })
})
