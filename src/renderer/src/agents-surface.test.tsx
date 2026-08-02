// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
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
    .queryAllByRole('button')
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

    // Chat state is driven by the port-judged runtime state: cc_data is
    // running, so it must NOT show the "send your first message" empty state.
    expect(view).toHaveTextContent('进行中的 Run')
    expect(view).not.toHaveTextContent('发送首条消息')

    // Activity sub-view is driven by the port snapshot.
    await user.click(within(view).getByRole('button', { name: '活动' }))
    expect(view).toHaveTextContent(/cc_data 开始清洗/)

    // Changes sub-view shows port-driven worktree changes.
    await user.click(within(view).getByRole('button', { name: '改动' }))
    expect(view).toHaveTextContent('src/clean.ts')
    expect(view).toHaveTextContent('验证：通过')
    expect(view).toHaveTextContent('ff-only 合并')

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

describe('Agents surface — port-driven chat state (#20)', () => {
  it('shows the neutral empty chat state for a ready agent', async () => {
    const { user, directory } = await gotoAgentsSurface()
    await user.click(
      within(directory).getByRole('button', { name: /cx_review/ })
    )
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    expect(view).toHaveTextContent('发送首条消息')
  })

  it('shows an unavailable notice instead of the empty prompt for unavailable agents', async () => {
    const { user, directory } = await gotoAgentsSurface()
    await user.click(
      within(directory).getByRole('button', { name: /kimi_docs/ })
    )
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    expect(view).toHaveTextContent('Provider 不可用')
    expect(view).not.toHaveTextContent('发送首条消息')
  })
})

describe('Agents surface — identity and view state (#20)', () => {
  it('distinguishes visible/open/terminal-takeover in the directory and shows provider on tabs', async () => {
    const { user, directory } = await gotoAgentsSurface()

    // cc_data is the only open tab and active in its panel → 当前可见.
    expect(within(directory).getByRole('button', { name: /cc_data/ })).toHaveTextContent(
      '当前可见'
    )
    // cx_anti holds a Terminal takeover in the mock scenario.
    expect(
      within(directory).getByRole('button', { name: /cx_anti/ })
    ).toHaveTextContent('Terminal 接管')
    // cx_review is not open anywhere → no view-state badge.
    expect(
      within(directory).getByRole('button', { name: /cx_review/ })
    ).not.toHaveTextContent('已打开')

    // Opening cc_sql makes it the visible tab; cc_data stays open in background.
    await user.click(within(directory).getByRole('button', { name: /cc_sql/ }))
    await screen.findAllByRole('tab', { name: /cc_sql/ })
    expect(within(directory).getByRole('button', { name: /cc_sql/ })).toHaveTextContent(
      '当前可见'
    )
    expect(
      within(directory).getByRole('button', { name: /cc_data/ })
    ).toHaveTextContent('已打开')

    // Tabs carry the provider as secondary identity.
    expect(screen.getByRole('tab', { name: /cc_data/ })).toHaveTextContent(
      'Claude Code'
    )
  })
})

describe('Agents surface — per-project filter isolation (#20)', () => {
  it('does not leak directory filters into another project', async () => {
    const { user, directory } = await gotoAgentsSurface()
    await user.type(
      within(directory).getByRole('textbox', { name: '搜索 Agent' }),
      'zzzz'
    )
    expect(directoryNames(directory)).toHaveLength(0)

    // Switch to the other project and open its Agents surface.
    await user.selectOptions(
      screen.getByRole('combobox', { name: '切换项目' }),
      '用户研究'
    )
    await screen.findByRole('heading', { name: '用户研究', level: 2 })
    await user.click(screen.getByRole('button', { name: 'Agent' }))

    const researchDirectory = await screen.findByRole('region', {
      name: 'Agent 目录'
    })
    expect(
      within(researchDirectory).getByRole('textbox', { name: '搜索 Agent' })
    ).toHaveValue('')
    expect(directoryNames(researchDirectory)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Changes sub-view — safe merge, drift, validation and confirmation (#8)
// ---------------------------------------------------------------------------

describe('Agents surface — Changes sub-view', () => {
  /** Renders the shell, navigates to the Agents surface, opens cc_data's
   *  Agent View and switches to the Changes sub-view. */
  async function gotoChanges() {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await screen.findByRole('button', { name: '概览' })
    await user.click(screen.getByRole('button', { name: 'Agent' }))
    await screen.findByRole('region', { name: 'Agent 目录' })
    // Click on cc_data agent to open Agent View
    await user.click(screen.getByRole('button', { name: /^cc_data/ }))
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '改动' }))
    return { user, view }
  }

  it('shows files, validation status and base commit for cc_data', async () => {
    const { view } = await gotoChanges()
    expect(view).toHaveTextContent('src/clean.ts')
    expect(view).toHaveTextContent('src/types.ts')
    expect(view).toHaveTextContent('验证：通过')
    expect(view).toHaveTextContent('a1b2c3d')
  })

  it('shows ff-only merge and discard buttons for a clean agent', async () => {
    const { view } = await gotoChanges()
    expect(
      within(view).getByRole('button', { name: 'ff-only 合并' })
    ).not.toBeDisabled()
    expect(
      within(view).getByRole('button', { name: '丢弃改动' })
    ).toBeVisible()
  })

  it('merge on clean agent triggers confirmation dialog', async () => {
    const { user, view } = await gotoChanges()
    await user.click(within(view).getByRole('button', { name: 'ff-only 合并' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('合并')
    expect(dialog).toHaveTextContent('cc_data')
  })

  it('confirming merge clears changes and closes dialog', async () => {
    const { user, view } = await gotoChanges()
    await user.click(within(view).getByRole('button', { name: 'ff-only 合并' }))
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: '确认' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Changes cleared — empty state now shows
    expect(view).toHaveTextContent('暂无改动')
  })

  it('canceling merge via cancel button keeps changes', async () => {
    const { user, view } = await gotoChanges()
    await user.click(within(view).getByRole('button', { name: 'ff-only 合并' }))
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Changes still present
    expect(view).toHaveTextContent('src/clean.ts')
  })

  it('discard triggers confirmation with discard action text', async () => {
    const { user, view } = await gotoChanges()
    await user.click(within(view).getByRole('button', { name: '丢弃改动' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('丢弃')
  })

  it('shows needs-rebase notice for drifted agent (cc_sql)', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await screen.findByRole('button', { name: '概览' })
    await user.click(screen.getByRole('button', { name: 'Agent' }))
    await screen.findByRole('region', { name: 'Agent 目录' })
    await user.click(screen.getByRole('button', { name: /^cc_sql/ }))
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '改动' }))
    expect(view).toHaveTextContent('需要 rebase')
    expect(
      within(view).getByRole('button', { name: 'ff-only 合并' })
    ).toBeDisabled()
  })

  it('shows validation failure for cx_anti', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)
    await screen.findByRole('button', { name: '概览' })
    await user.click(screen.getByRole('button', { name: 'Agent' }))
    await screen.findByRole('region', { name: 'Agent 目录' })
    await user.click(screen.getByRole('button', { name: /^cx_anti/ }))
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '改动' }))
    expect(view).toHaveTextContent('验证：失败')
    expect(
      within(view).getByRole('button', { name: 'ff-only 合并' })
    ).toBeDisabled()
  })

  it('does not call window.api during changes interactions', async () => {
    const apiSpy = vi.fn()
    Object.defineProperty(window, 'api', {
      value: apiSpy,
      writable: true,
      configurable: true
    })
    const { user, view } = await gotoChanges()
    await user.click(within(view).getByRole('button', { name: 'ff-only 合并' }))
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(apiSpy).not.toHaveBeenCalled()
  })
})
