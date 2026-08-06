// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'

/**
 * The fixed context directory pane (#66): 244px between the icon rail and
 * the workspace, visible on every Project surface, carrying the Project
 * identity card and the single Agent Directory (需要处理 / 全部实例 groups,
 * run-summary footer). Project switching lives in the top switch bar since
 * #75. Geometry (244px, panel minimums) is covered by the Electron smoke
 * specs; these tests observe structure and behaviour only.
 */

afterEach(() => cleanup())

async function renderShell() {
  const user = userEvent.setup()
  render(<ProjectShell port={new MockScenarioAdapter()} />)
  // #76: the app lands on 首页 — the pane appears once a Project is open.
  await user.click(
    within(
      await screen.findByRole('navigation', { name: '快捷切换' })
    ).getByRole('button', { name: '销售数据分析' })
  )
  const directory = await screen.findByRole('region', { name: 'Agent 目录' })
  return { user, directory }
}

describe('Context pane — fixed presence (#66)', () => {
  it('stays visible while switching between Project surfaces', async () => {
    const { user } = await renderShell()
    // Initial surface is Overview — the pane is already there.
    expect(
      screen.getByRole('region', { name: 'Agent 目录' })
    ).toBeVisible()

    await user.click(screen.getByRole('button', { name: '任务' }))
    expect(
      screen.getByRole('region', { name: '任务' })
    ).toBeVisible()
    expect(
      screen.getByRole('region', { name: 'Agent 目录' })
    ).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Agent' }))
    expect(
      screen.getByRole('region', { name: 'Agent 工作区' })
    ).toBeVisible()
    expect(
      screen.getByRole('region', { name: 'Agent 目录' })
    ).toBeVisible()
  })

  it('disappears in the global views, which have no Project context', async () => {
    const { user } = await renderShell()
    await user.click(screen.getByRole('button', { name: '连接' }))
    expect(
      screen.getByRole('region', { name: '全局连接' })
    ).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Agent 目录' })).toBeNull()
  })
})

describe('Context pane — directory footer (#66)', () => {
  it('shows the root path summary in the footer', async () => {
    const { directory } = await renderShell()
    // #92: the project identity card moved to the unified sidebar brand
    // mark + header. The directory footer still carries the root path.
    expect(
      within(directory).queryByRole('combobox', { name: '切换项目' })
    ).not.toBeInTheDocument()
    expect(
      within(directory).getByText('~/Projects/sales-analysis')
    ).toBeVisible()
  })

  it('follows the project switched from the top bar', async () => {
    const { user } = await renderShell()
    await user.click(
      within(
        screen.getByRole('navigation', { name: '快捷切换' })
      ).getByRole('button', { name: '用户研究' })
    )
    // The pane remounts per Project — re-query before asserting.
    const next = await screen.findByRole('region', { name: 'Agent 目录' })
    // Project name is in the header; the directory shows this project's
    // agents and root path.
    expect(
      within(next).getByText('~/Projects/user-research')
    ).toBeVisible()
    expect(
      within(next).getByRole('button', { name: /^cc_report/ })
    ).toBeInTheDocument()
    expect(
      within(next).queryByRole('button', { name: /^cc_data/ })
    ).toBeNull()
  })
})

describe('Context pane — Agent Directory content (#66)', () => {
  it('shows the AGENT DIRECTORY head with the new-agent action', async () => {
    const { directory } = await renderShell()
    expect(
      within(directory).getByRole('heading', { name: 'Agent Directory' })
    ).toBeVisible()
    expect(
      within(directory).getByRole('button', { name: '新建 Agent' })
    ).toBeVisible()
  })

  it('groups the attention family under 需要处理 with a count consistent with the Attention data', async () => {
    const { directory } = await renderShell()
    const list = within(directory).getByRole('list', { name: 'Agent 列表' })
    const needsAttention = within(list).getByText('需要处理')
    // cc_data (permission-requested), cc_sql (needs-input) and cc_etl
    // (failed) — the three agents the open Attention items point at.
    expect(needsAttention.parentElement).toHaveTextContent('3')
    expect(
      within(list).getByRole('button', { name: /^cc_data/ })
    ).toBeInTheDocument()
    expect(
      within(list).getByRole('button', { name: /^cc_sql/ })
    ).toBeInTheDocument()
    expect(
      within(list).getByRole('button', { name: /^cc_etl/ })
    ).toBeInTheDocument()
    expect(within(list).getByText('全部实例')).toBeVisible()
  })

  it('renders rows with provider icon, mono name, secondary label and the shared status dot', async () => {
    const { directory } = await renderShell()
    const row = within(directory).getByRole('button', { name: /^cc_data/ })
    // #79: Provider brand icon replaces the old CC text avatar; the icon
    // is aria-hidden and the accessible name still starts with the Agent Name.
    expect(row.querySelector('svg')).not.toBeNull()
    // Secondary label names provider and state in text (non-color cue).
    expect(row).toHaveTextContent('Claude Code · 等待权限')
    // The single global status-dot implementation (#65), attention family.
    expect(row.querySelector('.state-dot.state-dot-attention')).not.toBeNull()
  })

  it('collapses the groups into one flat result list while a search is active', async () => {
    const { user, directory } = await renderShell()
    await user.type(
      within(directory).getByRole('textbox', { name: '搜索 Agent' }),
      'kimi'
    )
    const list = within(directory).getByRole('list', { name: 'Agent 列表' })
    expect(within(list).queryByText('需要处理')).toBeNull()
    expect(within(list).queryByText('全部实例')).toBeNull()
    expect(
      within(list)
        .getAllByRole('button')
        .filter(
          (b) =>
            !b.getAttribute('aria-label')?.startsWith('在新 Panel 打开') &&
            !b.getAttribute('aria-label')?.startsWith('关闭')
        )
    ).toHaveLength(2)
  })

  it('matches the search box against Provider and state labels too', async () => {
    const { user, directory } = await renderShell()
    await user.type(
      within(directory).getByRole('textbox', { name: '搜索 Agent' }),
      'codex'
    )
    const list = within(directory).getByRole('list', { name: 'Agent 列表' })
    expect(within(list).getByRole('button', { name: /^cx_anti/ })).toBeInTheDocument()
    expect(
      within(list).queryByRole('button', { name: /^cc_data/ })
    ).toBeNull()
  })

  it('shows the run summary and root path in the footer from contract data', async () => {
    const { directory } = await renderShell()
    // activeRunCount 2 (contract) and the three-strong attention family.
    expect(directory).toHaveTextContent('2 个运行中 · 3 个等待确认')
  })
})
