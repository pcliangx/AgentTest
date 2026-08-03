// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'
import type { WorkbenchPort } from './workbench/contract'

/**
 * Settings A — the single full configuration editor (#13). Tests drive the
 * surface through the MockScenarioAdapter and observe accessible roles,
 * names and port-produced ViewModels — never internal component state.
 */

afterEach(() => cleanup())

async function gotoSettingsSurface(port?: WorkbenchPort) {
  const user = userEvent.setup()
  render(<ProjectShell port={port ?? new MockScenarioAdapter()} />)
  await screen.findByRole('button', { name: '概览' })
  await user.click(screen.getByRole('button', { name: '设置' }))
  await screen.findByRole('region', { name: '项目设置' })
  return { user }
}

function summaryPanel(): HTMLElement {
  return screen.getByRole('complementary', { name: '待应用摘要' })
}

/** Stages a text-field change: clear, type, then blur to commit the draft. */
async function stageText(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  value: string
) {
  const input = screen.getByRole('textbox', { name: label })
  await user.clear(input)
  if (value) await user.type(input, value)
  fireEvent.blur(input)
}

describe('Settings A — catalogue and chrome', () => {
  it('keeps the project navigation and global entries while showing the stable section catalogue', async () => {
    await gotoSettingsSurface()
    // Project navigation and global chrome survive on the Settings surface.
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeDefined()
    expect(
      screen.getByRole('button', { name: '派发给 Agent' })
    ).toBeDefined()

    const settings = screen.getByRole('region', { name: '项目设置' })
    const catalogue = within(settings).getByRole('navigation', {
      name: '设置目录'
    })
    for (const name of [
      '常规',
      'Agent 默认配置',
      'Agent 实例',
      '集成',
      '权限',
      '存储'
    ]) {
      expect(
        within(catalogue).getByRole('button', { name })
      ).toBeDefined()
    }

    // Auto-save boundary is stated explicitly (US §11.2).
    within(settings).getByText(/布局、当前工作面与过滤器会自动保存/)
  })

  it('shows read-only storage facts with disabled export/import placeholders', async () => {
    const { user } = await gotoSettingsSurface()
    await user.click(screen.getByRole('button', { name: '存储' }))
    expect(screen.getByText(/本地数据仅保存在本机/)).toBeDefined()
    expect(screen.getByRole('button', { name: '导出' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '导入' })).toBeDisabled()
  })
})

describe('Settings A — draft lifecycle', () => {
  it('shows applied values and stages a draft without changing applied truth', async () => {
    const { user } = await gotoSettingsSurface()
    // General is the default section: applied value and version visible.
    const nameInput = screen.getByRole('textbox', { name: '项目名称' })
    expect(nameInput).toHaveValue('销售数据分析')
    expect(screen.getByText('当前：销售数据分析（v2）')).toBeDefined()

    await stageText(user, '项目名称', '销售分析 v2')

    // The draft is visible but the applied truth has not moved (US-68).
    expect(screen.getByText('待应用：销售分析 v2')).toBeDefined()
    expect(screen.getByText('当前：销售数据分析（v2）')).toBeDefined()
    expect(
      within(summaryPanel()).getByText(/销售数据分析.*1 项变更/)
    ).toBeDefined()
  })

  it('previews discard and preserves the draft when cancelled or closed', async () => {
    const port = new MockScenarioAdapter()
    const { user } = await gotoSettingsSurface(port)
    await stageText(user, '项目名称', '销售分析 v2')
    expect(screen.getByText('待应用：销售分析 v2')).toBeDefined()

    await user.click(
      screen.getByRole('button', { name: '丢弃「销售数据分析」的草稿' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: '丢弃配置草稿'
    })
    expect(dialog).toHaveTextContent('销售数据分析')
    expect(dialog).toHaveTextContent('项目名称')
    expect(dialog).toHaveTextContent('销售数据分析 → 销售分析 v2')
    expect(dialog).toHaveTextContent('不可恢复')
    expect((await port.getSnapshot()).configurationDrafts).toHaveLength(1)

    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('待应用：销售分析 v2')).toBeDefined()
    expect((await port.getSnapshot()).configurationDrafts).toHaveLength(1)

    await user.click(
      screen.getByRole('button', { name: '丢弃「销售数据分析」的草稿' })
    )
    await screen.findByRole('dialog', {
      name: '丢弃配置草稿'
    })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('待应用：销售分析 v2')).toBeDefined()
    expect((await port.getSnapshot()).configurationDrafts).toHaveLength(1)
  })

  it('confirms discard for only the previewed owner and records the result', async () => {
    const port = new MockScenarioAdapter()
    const { user } = await gotoSettingsSurface(port)
    await stageText(user, '项目名称', '销售分析 v2')
    await user.click(screen.getByRole('button', { name: 'Agent 实例' }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: '选择实例' }),
      'cc_data'
    )
    await stageText(user, '模型', 'model-a')

    await user.click(
      screen.getByRole('button', { name: '丢弃「销售数据分析」的草稿' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: '丢弃配置草稿'
    })
    await user.click(within(dialog).getByRole('button', { name: '确认' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      within(summaryPanel()).queryByText(/销售数据分析.*1 项变更/)
    ).toBeNull()
    expect(within(summaryPanel()).getByText(/cc_data.*1 项变更/)).toBeDefined()
    expect(screen.getByRole('textbox', { name: '模型' })).toHaveValue('model-a')

    const snapshot = await port.getSnapshot()
    expect(
      snapshot.configurationDrafts.some(
        (draft) => draft.owner.kind === 'project'
      )
    ).toBe(false)
    expect(
      snapshot.configurationDrafts.some(
        (draft) => draft.owner.kind === 'agent'
      )
    ).toBe(true)
    expect(snapshot.activity[0].summary).toContain('丢弃配置草稿')
  })

  it('isolates drafts between two instances for the same field path', async () => {
    const { user } = await gotoSettingsSurface()
    await user.click(screen.getByRole('button', { name: 'Agent 实例' }))

    await user.selectOptions(
      screen.getByRole('combobox', { name: '选择实例' }),
      'cc_data'
    )
    await stageText(user, '模型', 'model-a')

    await user.selectOptions(
      screen.getByRole('combobox', { name: '选择实例' }),
      'cc_sql'
    )
    await stageText(user, '模型', 'model-b')

    // Each owner carries exactly its own change (US-67).
    expect(within(summaryPanel()).getByText(/cc_data.*1 项变更/)).toBeDefined()
    expect(within(summaryPanel()).getByText(/cc_sql.*1 项变更/)).toBeDefined()

    // Switching back shows that instance's own draft, not the other's.
    await user.selectOptions(
      screen.getByRole('combobox', { name: '选择实例' }),
      'cc_data'
    )
    expect(screen.getByRole('textbox', { name: '模型' })).toHaveValue('model-a')
    await user.selectOptions(
      screen.getByRole('combobox', { name: '选择实例' }),
      'cc_sql'
    )
    expect(screen.getByRole('textbox', { name: '模型' })).toHaveValue('model-b')
  })

  it('marks identity changes as immediate and run configuration as next-Run', async () => {
    const { user } = await gotoSettingsSurface()
    await user.click(screen.getByRole('button', { name: 'Agent 实例' }))
    const nameRow = screen.getByRole('textbox', { name: 'Agent 名称' })
    expect(within(nameRow.closest('li')!).getByText('立即生效')).toBeDefined()
    const modelRow = screen.getByRole('textbox', { name: '模型' })
    expect(
      within(modelRow.closest('li')!).getByText('下一 Run 生效')
    ).toBeDefined()
  })
})

describe('Settings A — atomic apply', () => {
  it('previews the change summary, then commits all owners atomically', async () => {
    const { user } = await gotoSettingsSurface()
    await stageText(user, '项目名称', '销售分析 v2')
    await user.click(screen.getByRole('button', { name: 'Agent 实例' }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: '选择实例' }),
      'cc_data'
    )
    await stageText(user, '模型', 'claude-opus-4')

    await user.click(screen.getByRole('button', { name: '应用全部变更' }))
    const dialog = await screen.findByRole('dialog', {
      name: '应用配置变更'
    })
    // The summary names every owner, field and before/after value (US-70).
    within(dialog).getByText(/销售数据分析 · 项目名称：销售数据分析 → 销售分析 v2/)
    within(dialog).getByText(/cc_data · 模型：claude-sonnet-4 → claude-opus-4/)

    await user.click(within(dialog).getByRole('button', { name: '确认应用' }))

    // Drafts cleared, versions bumped, applied view updated.
    expect(within(summaryPanel()).getByText('暂无待应用变更')).toBeDefined()
    expect(await screen.findByRole('status')).toHaveTextContent(/已应用/)
    await user.click(screen.getByRole('button', { name: '常规' }))
    expect(screen.getByText('当前：销售分析 v2（v3）')).toBeDefined()
    // Project name takes effect immediately — the switcher shows it.
    expect(
      within(
        screen.getByRole('navigation', { name: '主导航' })
      ).getByRole('combobox', { name: '切换项目' })
    ).toHaveTextContent('销售分析 v2')
  })

  it('keeps every draft and shows an error when any owner fails validation', async () => {
    const { user } = await gotoSettingsSurface()
    await user.click(screen.getByRole('button', { name: 'Agent 实例' }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: '选择实例' }),
      'cc_sql'
    )
    // Invalid empty name for cc_sql, valid model change for cc_data.
    await stageText(user, 'Agent 名称', '')
    await user.selectOptions(
      screen.getByRole('combobox', { name: '选择实例' }),
      'cc_data'
    )
    await stageText(user, '模型', 'claude-opus-4')

    await user.click(screen.getByRole('button', { name: '应用全部变更' }))
    const dialog = await screen.findByRole('dialog', { name: '应用配置变更' })
    await user.click(within(dialog).getByRole('button', { name: '确认应用' }))

    // Atomic failure: alert shown, nothing applied, all drafts kept (US-70).
    expect(await screen.findByRole('alert')).toHaveTextContent(/未通过验证/)
    expect(within(summaryPanel()).getByText(/cc_sql.*1 项变更/)).toBeDefined()
    expect(within(summaryPanel()).getByText(/cc_data.*1 项变更/)).toBeDefined()
    expect(screen.getByRole('textbox', { name: '模型' })).toHaveValue(
      'claude-opus-4'
    )
    expect(screen.getByText('当前：claude-sonnet-4（v3）')).toBeDefined()
  })

  it('applies an agent rename immediately while the active Run keeps its snapshot', async () => {
    const { user } = await gotoSettingsSurface()
    await user.click(screen.getByRole('button', { name: 'Agent 实例' }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: '选择实例' }),
      'cc_sql'
    )
    await stageText(user, 'Agent 名称', 'cc_sql_v2')
    // A run-configuration change on the running instance cc_data too.
    await user.selectOptions(
      screen.getByRole('combobox', { name: '选择实例' }),
      'cc_data'
    )
    expect(screen.getByText(/当前 Run 配置快照：v3/)).toBeDefined()
    await stageText(user, '模型', 'claude-opus-4')

    await user.click(screen.getByRole('button', { name: '应用全部变更' }))
    const dialog = await screen.findByRole('dialog', { name: '应用配置变更' })
    await user.click(within(dialog).getByRole('button', { name: '确认应用' }))

    // Name + routing metadata are effective at once (US-91)…
    const picker = screen.getByRole('combobox', { name: '选择实例' })
    expect(within(picker).getByRole('option', { name: 'cc_sql_v2' })).toBeDefined()
    // …while the active Run keeps its launch-time snapshot (US-71).
    expect(screen.getByText(/当前 Run 配置快照：v3/)).toBeDefined()
    expect(screen.getByText('当前：claude-opus-4（v4）')).toBeDefined()
  })
})

describe('Settings A — integrations', () => {
  it('offers 0..1 primary connection including the empty option', async () => {
    const { user } = await gotoSettingsSurface()
    await user.click(screen.getByRole('button', { name: '集成' }))

    const select = screen.getByRole('combobox', { name: '主连接' })
    expect(select).toHaveValue('conn-feishu-primary')
    within(select).getByRole('option', { name: '无连接' })

    await user.selectOptions(select, '')
    expect(screen.getByText('待应用：无连接')).toBeDefined()
    expect(
      screen.getByText('当前：飞书 · 销售团队（v2）')
    ).toBeDefined()
  })
})

describe('Settings A — project scoping', () => {
  it('shows and applies only the current project drafts', async () => {
    const { user } = await gotoSettingsSurface()
    await stageText(user, '项目名称', '销售分析 v2')
    expect(
      within(summaryPanel()).getByText(/销售数据分析.*1 项变更/)
    ).toBeDefined()

    // Switch to the other project: another project's drafts must not leak
    // into this summary, and there is nothing to apply here.
    const nav = screen.getByRole('navigation', { name: '主导航' })
    await user.selectOptions(
      within(nav).getByRole('combobox', { name: '切换项目' }),
      '用户研究'
    )
    await user.click(screen.getByRole('button', { name: '设置' }))
    expect(within(summaryPanel()).getByText('暂无待应用变更')).toBeDefined()
    expect(screen.getByRole('button', { name: '应用全部变更' })).toBeDisabled()
  })

  it('resets the instance selection when switching projects', async () => {
    const { user } = await gotoSettingsSurface()
    await user.click(screen.getByRole('button', { name: 'Agent 实例' }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: '选择实例' }),
      'cc_sql'
    )

    // Put BOTH projects on the Settings surface, so switching projects
    // reuses the mounted SettingsSurface instead of unmounting it.
    const nav = screen.getByRole('navigation', { name: '主导航' })
    await user.selectOptions(
      within(nav).getByRole('combobox', { name: '切换项目' }),
      '用户研究'
    )
    await user.click(screen.getByRole('button', { name: '设置' }))

    // Back to sales (still on Settings) and pick cc_sql again.
    await user.selectOptions(
      within(nav).getByRole('combobox', { name: '切换项目' }),
      '销售数据分析'
    )
    await user.click(screen.getByRole('button', { name: 'Agent 实例' }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: '选择实例' }),
      'cc_sql'
    )

    // Switch to research while both stay on Settings: the selection must
    // be rebuilt for the research project, never left dangling on cc_sql.
    await user.selectOptions(
      within(nav).getByRole('combobox', { name: '切换项目' }),
      '用户研究'
    )
    await user.click(screen.getByRole('button', { name: 'Agent 实例' }))

    expect(screen.getByRole('combobox', { name: '选择实例' })).toHaveValue(
      'inst-cc-report'
    )
    expect(screen.getByRole('textbox', { name: 'Agent 名称' })).toHaveValue(
      'cc_report'
    )
  })
})
