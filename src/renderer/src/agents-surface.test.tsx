// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'

afterEach(() => cleanup())

/** Renders the shell and navigates to the Agents surface. */
async function gotoAgentsSurface() {
  const user = userEvent.setup()
  render(<ProjectShell port={new MockScenarioAdapter()} />)
  await screen.findByRole('button', { name: '概览' })
  await user.click(screen.getByRole('button', { name: 'Agent' }))
  const directory = await screen.findByRole('region', { name: 'Agent 目录' })
  return { user, directory }
}

/** Names of agent buttons currently listed in the directory. */
function directoryNames(directory: HTMLElement): string[] {
  const list = within(directory).getByRole('list', { name: 'Agent 列表' })
  return within(list)
    .getAllByRole('button')
    .map((b) => b.textContent ?? '')
}

describe('Agents surface — Agent Directory', () => {
  it('lists at least eight instances of the active project with name primary and provider secondary', async () => {
    const { directory } = await gotoAgentsSurface()
    const names = directoryNames(directory)
    expect(names.length).toBeGreaterThanOrEqual(8)
    expect(names.some((n) => n.includes('cc_data'))).toBe(true)
    expect(names.some((n) => n.includes('kimi_docs'))).toBe(true)
    // Provider is shown as secondary information, and one provider repeats.
    const claudeEntries = within(directory)
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes('Claude Code'))
    expect(claudeEntries.length).toBeGreaterThan(1)
  })

  it('does not list agents from other projects', async () => {
    const { directory } = await gotoAgentsSurface()
    expect(directoryNames(directory).some((n) => n.includes('cc_report'))).toBe(
      false
    )
  })

  it('searches by agent name', async () => {
    const { user, directory } = await gotoAgentsSurface()
    await user.type(
      within(directory).getByRole('textbox', { name: '搜索 Agent' }),
      'kimi'
    )
    const names = directoryNames(directory)
    expect(names).toHaveLength(2)
    expect(names.every((n) => n.includes('kimi'))).toBe(true)
  })

  it('filters by provider', async () => {
    const { user, directory } = await gotoAgentsSurface()
    await user.selectOptions(
      within(directory).getByRole('combobox', { name: '按 Provider 过滤' }),
      'Codex'
    )
    const names = directoryNames(directory)
    expect(names).toHaveLength(3)
    expect(names.every((n) => n.includes('cx_'))).toBe(true)
  })

  it('filters by runtime state', async () => {
    const { user, directory } = await gotoAgentsSurface()
    await user.selectOptions(
      within(directory).getByRole('combobox', { name: '按状态过滤' }),
      '运行中'
    )
    const names = directoryNames(directory)
    expect(names).toHaveLength(1)
    expect(names[0]).toContain('cc_data')
  })

  it('sorts by recent activity when selected', async () => {
    const { user, directory } = await gotoAgentsSurface()
    await user.selectOptions(
      within(directory).getByRole('combobox', { name: '排序方式' }),
      '最近活动'
    )
    const names = directoryNames(directory)
    expect(names[0]).toContain('cx_review')
    expect(names[names.length - 1]).toContain('kimi_docs')
  })
})

describe('Agents surface — New Agent', () => {
  it('lists only Doctor-ready providers', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(screen.getByRole('button', { name: '新建 Agent' }))
    const providerSelect = await screen.findByRole('combobox', {
      name: 'Provider'
    })
    const options = within(providerSelect)
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options).toContain('Claude Code')
    expect(options).toContain('Codex')
    expect(options).toContain('Kimi Code')
    expect(options).not.toContain('Gemini CLI')
  })

  it('creates a Ready instance opened as a tab in the current panel', async () => {
    const { user, directory } = await gotoAgentsSurface()
    await user.click(screen.getByRole('button', { name: '新建 Agent' }))
    await user.type(
      await screen.findByRole('textbox', { name: 'Agent 名称' }),
      'cc_review2'
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Provider' }),
      'Claude Code'
    )
    await user.click(screen.getByRole('button', { name: '创建 Agent' }))

    // Directory gains the new instance with ready state.
    expect(
      (await screen.findByRole('region', { name: 'Agent 目录' })).textContent
    ).toContain('cc_review2')
    expect(directoryNames(directory)).toHaveLength(9)
    // A new unique tab appears and becomes active, showing 就绪 state.
    const tabs = await screen.findAllByRole('tab', { name: /cc_review2/ })
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('region', { name: 'Agent 视图' })).toHaveTextContent(
      '就绪'
    )
  })

  it('creates a background instance without opening a tab', async () => {
    const { user, directory } = await gotoAgentsSurface()
    await user.click(screen.getByRole('button', { name: '新建 Agent' }))
    await user.type(
      await screen.findByRole('textbox', { name: 'Agent 名称' }),
      'cx_bg'
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Provider' }),
      'Codex'
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: '打开方式' }),
      '后台打开'
    )
    await user.click(screen.getByRole('button', { name: '创建 Agent' }))

    expect(directoryNames(directory).some((n) => n.includes('cx_bg'))).toBe(
      true
    )
    expect(screen.queryByRole('tab', { name: /cx_bg/ })).toBeNull()
  })

  it('rejects a duplicate name and keeps the directory unchanged', async () => {
    const { user, directory } = await gotoAgentsSurface()
    await user.click(screen.getByRole('button', { name: '新建 Agent' }))
    await user.type(
      await screen.findByRole('textbox', { name: 'Agent 名称' }),
      'CC_DATA'
    )
    await user.click(screen.getByRole('button', { name: '创建 Agent' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/已存在/)
    expect(directoryNames(directory)).toHaveLength(8)
    expect(screen.queryByRole('tab', { name: /CC_DATA/ })).toBeNull()
  })
})

describe('Agents surface — unique Agent Tab', () => {
  it('opening an instance from the directory adds its tab; reopening only focuses it', async () => {
    const { user, directory } = await gotoAgentsSurface()
    const ccSql = within(directory).getByRole('button', { name: /cc_sql/ })

    await user.click(ccSql)
    expect(
      (await screen.findAllByRole('tab', { name: /cc_sql/ })).length
    ).toBe(1)

    // Click again — still exactly one tab, now selected.
    await user.click(within(directory).getByRole('button', { name: /cc_sql/ }))
    const tabs = await screen.findAllByRole('tab', { name: /cc_sql/ })
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('switching between tabs activates the clicked one', async () => {
    const { user, directory } = await gotoAgentsSurface()
    await user.click(within(directory).getByRole('button', { name: /cc_sql/ }))
    await screen.findAllByRole('tab', { name: /cc_sql/ })

    await user.click(screen.getByRole('tab', { name: /cc_data/ }))
    expect(screen.getByRole('tab', { name: /cc_data/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByRole('tab', { name: /cc_sql/ })).toHaveAttribute(
      'aria-selected',
      'false'
    )
  })

  it('closing a tab only closes the view — the instance keeps its state in the directory', async () => {
    const { user, directory } = await gotoAgentsSurface()
    // cc_data starts open and running.
    expect(screen.getByRole('tab', { name: /cc_data/ })).toBeDefined()
    await user.click(screen.getByRole('button', { name: '关闭标签 cc_data' }))

    expect(screen.queryByRole('tab', { name: /cc_data/ })).toBeNull()
    const entry = within(directory).getByRole('button', { name: /cc_data/ })
    expect(entry).toHaveTextContent('运行中')
  })

  it('closing the last tab shows the empty workspace state', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(screen.getByRole('button', { name: '关闭标签 cc_data' }))
    expect(await screen.findByText(/尚未打开任何 Agent/)).toBeVisible()
  })
})

describe('Agents surface — Agent View', () => {
  it('shows the four secondary entries and port-driven basic states', async () => {
    const { user } = await gotoAgentsSurface()
    const view = await screen.findByRole('region', { name: 'Agent 视图' })

    // cc_data is open by default: name primary, provider and state secondary.
    expect(within(view).getByRole('heading', { name: 'cc_data' })).toBeVisible()
    expect(view).toHaveTextContent('Claude Code')
    expect(view).toHaveTextContent('运行中')

    for (const label of ['对话', '活动', '改动', 'Terminal']) {
      expect(
        within(view).getByRole('button', { name: label })
      ).toBeVisible()
    }

    // Chat empty state by default.
    expect(view).toHaveTextContent('暂无对话')

    // Activity sub-view is driven by the port snapshot.
    await user.click(within(view).getByRole('button', { name: '活动' }))
    expect(view).toHaveTextContent(/cc_data 开始清洗/)

    // Changes empty state.
    await user.click(within(view).getByRole('button', { name: '改动' }))
    expect(view).toHaveTextContent('暂无改动')

    // Terminal takeover state from the port.
    await user.click(within(view).getByRole('button', { name: 'Terminal' }))
    expect(view).toHaveTextContent('Terminal 未接管')
  })

  it('marks a tab whose instance has an open attention item', async () => {
    const { user, directory } = await gotoAgentsSurface()
    await user.click(within(directory).getByRole('button', { name: /cc_sql/ }))
    const tab = (await screen.findAllByRole('tab', { name: /cc_sql/ }))[0]
    expect(
      within(tab).getByRole('img', { name: '有待处理事项' })
    ).toBeInTheDocument()
  })
})
