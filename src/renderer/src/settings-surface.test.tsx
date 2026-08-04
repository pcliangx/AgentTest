// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'
import { createStandardScenario } from './workbench/standard-scenario'
import { id } from './workbench/contract'
import type {
  CommandResult,
  WorkbenchCommand,
  WorkbenchEvent,
  WorkbenchPort,
  WorkbenchViewModel
} from './workbench/contract'

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
  value: string,
  waitForCompletion = true
) {
  const input = screen.getByRole('textbox', { name: label })
  await user.clear(input)
  if (value) await user.type(input, value)
  fireEvent.blur(input)
  if (waitForCompletion) {
    await waitFor(() =>
      expect(summaryPanel()).toHaveAttribute('aria-busy', 'false')
    )
  }
}

/** Advances the real adapter once before the first stage reaches it. */
class RevisionRaceStagePort implements WorkbenchPort {
  private readonly inner = new MockScenarioAdapter()
  private advanced = false

  getSnapshot() {
    return this.inner.getSnapshot()
  }

  planDispatch: WorkbenchPort['planDispatch'] = (request) =>
    this.inner.planDispatch(request)

  subscribe(listener: Parameters<WorkbenchPort['subscribe']>[0]) {
    return this.inner.subscribe(listener)
  }

  async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    if (command.kind === 'stage-configuration' && !this.advanced) {
      this.advanced = true
      await this.inner.dispatch({
        kind: 'navigate',
        commandId: id('cmd-stage-race-advance', 'CommandId'),
        expectedRevision: command.expectedRevision,
        projectId: id('proj-sales', 'ProjectId'),
        surface: 'settings'
      })
    }
    return this.inner.dispatch(command)
  }
}

/** Rejects the first stage without publishing an authoritative change. */
class RejectingStagePort implements WorkbenchPort {
  private readonly inner = new MockScenarioAdapter()
  private stageCount = 0

  constructor(private readonly rejectOnStage = 1) {}

  getSnapshot() {
    return this.inner.getSnapshot()
  }

  planDispatch: WorkbenchPort['planDispatch'] = (request) =>
    this.inner.planDispatch(request)

  subscribe(listener: Parameters<WorkbenchPort['subscribe']>[0]) {
    return this.inner.subscribe(listener)
  }

  async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    if (command.kind === 'stage-configuration') {
      this.stageCount += 1
    }
    if (
      command.kind === 'stage-configuration' &&
      this.stageCount === this.rejectOnStage
    ) {
      const latest = await this.inner.getSnapshot()
      return {
        ok: false,
        commandId: command.commandId,
        reason: 'invalid-target',
        latestRevision: latest.revision,
        message: '字段验证已失效，请重新输入'
      }
    }
    return this.inner.dispatch(command)
  }
}

/** Returns a successful stage response before publishing its buffered event. */
class ResponseBeforeStageEventPort implements WorkbenchPort {
  private readonly inner = new MockScenarioAdapter()
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>()
  private readonly bufferedEvents: WorkbenchEvent[] = []
  private bufferingStage = false
  stageResponseCount = 0

  constructor() {
    this.inner.subscribe((event) => {
      if (this.bufferingStage) {
        this.bufferedEvents.push(event)
      } else {
        for (const listener of this.listeners) listener(event)
      }
    })
  }

  getSnapshot() {
    return this.inner.getSnapshot()
  }

  planDispatch: WorkbenchPort['planDispatch'] = (request) =>
    this.inner.planDispatch(request)

  subscribe(listener: (event: WorkbenchEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    if (command.kind !== 'stage-configuration') {
      return this.inner.dispatch(command)
    }
    this.bufferingStage = true
    const result = await this.inner.dispatch(command)
    this.bufferingStage = false
    this.stageResponseCount += 1
    return result
  }

  publishStageEvents(): void {
    const events = this.bufferedEvents.splice(0)
    for (const event of events) {
      for (const listener of this.listeners) listener(event)
    }
  }
}

/** Defers stage commands while every other command uses the real adapter. */
class DeferredStagePort implements WorkbenchPort {
  private readonly inner = new MockScenarioAdapter()
  private readonly pendingStages: Array<{
    command: WorkbenchCommand
    resolve: (result: CommandResult) => void
  }> = []
  readonly releasedStageCommands: WorkbenchCommand[] = []
  readonly releasedStageResults: CommandResult[] = []

  get pendingStageCount(): number {
    return this.pendingStages.length
  }

  getSnapshot() {
    return this.inner.getSnapshot()
  }

  planDispatch: WorkbenchPort['planDispatch'] = (request) =>
    this.inner.planDispatch(request)

  subscribe(listener: Parameters<WorkbenchPort['subscribe']>[0]) {
    return this.inner.subscribe(listener)
  }

  dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    if (command.kind !== 'stage-configuration') {
      return this.inner.dispatch(command)
    }
    return new Promise((resolve) => {
      this.pendingStages.push({ command, resolve })
    })
  }

  async releaseNextStage(): Promise<void> {
    const pending = this.pendingStages.shift()
    if (!pending) throw new Error('no pending stage command')
    this.releasedStageCommands.push(pending.command)
    const result = await this.inner.dispatch(pending.command)
    this.releasedStageResults.push(result)
    pending.resolve(result)
    await Promise.resolve()
  }

  async rejectNextStage(): Promise<void> {
    const pending = this.pendingStages.shift()
    if (!pending) throw new Error('no pending stage command')
    this.releasedStageCommands.push(pending.command)
    const snapshot = await this.inner.getSnapshot()
    const result: CommandResult = {
      ok: false,
      commandId: pending.command.commandId,
      reason: 'invalid-target',
      latestRevision: snapshot.revision,
      message: '字段验证已失效，请重新输入'
    }
    this.releasedStageResults.push(result)
    pending.resolve(result)
    await Promise.resolve()
  }
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

describe('Settings A — asynchronous staging', () => {
  it('restores authoritative input and shows an alert after a revision race rejects stage', async () => {
    const port = new RevisionRaceStagePort()
    const { user } = await gotoSettingsSurface(port)

    await stageText(user, '项目名称', '幽灵草稿')

    expect(await screen.findByRole('alert')).toHaveTextContent(/revision 已过期/)
    expect(screen.getByRole('textbox', { name: '项目名称' })).toHaveValue(
      '销售数据分析'
    )
    expect(within(summaryPanel()).getByText('暂无待应用变更')).toBeDefined()
    const snapshot = await port.getSnapshot()
    expect(
      snapshot.configurationDrafts.some((draft) =>
        draft.changes.some((change) => change.fieldPath === 'general.name')
      )
    ).toBe(false)
  })

  it('restores authoritative input and shows the reason after a non-stale rejection', async () => {
    const port = new RejectingStagePort()
    const { user } = await gotoSettingsSurface(port)

    await stageText(user, '项目名称', '不会被接受')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '字段验证已失效，请重新输入'
    )
    expect(screen.getByRole('textbox', { name: '项目名称' })).toHaveValue(
      '销售数据分析'
    )
    expect(within(summaryPanel()).getByText('暂无待应用变更')).toBeDefined()
  })

  it('restores the existing authoritative draft rather than the applied value after rejection', async () => {
    const port = new RejectingStagePort(2)
    const { user } = await gotoSettingsSurface(port)

    await stageText(user, '项目名称', '已暂存名称')
    expect(screen.getByText('待应用：已暂存名称')).toBeDefined()

    await stageText(user, '项目名称', '被拒绝名称')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '字段验证已失效，请重新输入'
    )
    expect(screen.getByRole('textbox', { name: '项目名称' })).toHaveValue(
      '已暂存名称'
    )
    expect(screen.getByText('待应用：已暂存名称')).toBeDefined()
    const snapshot = await port.getSnapshot()
    expect(snapshot.configurationDrafts[0].changes[0].draft).toBe('已暂存名称')
  })

  it('keeps stage pending until a success response is followed by its authoritative event', async () => {
    const port = new ResponseBeforeStageEventPort()
    const { user } = await gotoSettingsSurface(port)

    await stageText(user, '项目名称', '响应先到', false)
    await waitFor(() => expect(port.stageResponseCount).toBe(1))

    expect(summaryPanel()).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: '应用全部变更' })).toBeDisabled()
    expect(within(summaryPanel()).getByText('暂无待应用变更')).toBeDefined()

    await act(async () => port.publishStageEvents())

    await waitFor(() =>
      expect(summaryPanel()).toHaveAttribute('aria-busy', 'false')
    )
    expect(screen.getByText('待应用：响应先到')).toBeDefined()
    expect(screen.getByRole('textbox', { name: '项目名称' })).toHaveValue(
      '响应先到'
    )
    expect(screen.getByRole('button', { name: '应用全部变更' })).toBeEnabled()
  })

  it('drains already queued stages when Settings unmounts before a response', async () => {
    const port = new DeferredStagePort()
    const { user } = await gotoSettingsSurface(port)

    await user.click(screen.getByRole('button', { name: 'Agent 默认配置' }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: '默认 Provider' }),
      'codex'
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: '新建 Agent 打开方式' }),
      'background'
    )
    await waitFor(() => expect(port.pendingStageCount).toBe(1))

    await user.click(screen.getByRole('button', { name: '概览' }))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '项目设置' })).toBeNull()
    )
    await act(async () => port.releaseNextStage())
    await waitFor(() => expect(port.pendingStageCount).toBe(1))
    await act(async () => port.releaseNextStage())

    expect(
      port.releasedStageCommands.map((command) =>
        command.kind === 'stage-configuration' ? command.fieldPath : ''
      )
    ).toEqual(['defaults.providerId', 'defaults.openMode'])
    expect(port.releasedStageResults[0]).toMatchObject({
      ok: false,
      reason: 'stale-revision'
    })
    expect(port.releasedStageResults[1]).toMatchObject({ ok: true })
  })

  it('serializes rapid stages for one field and keeps Apply disabled until the latest draft is authoritative', async () => {
    const port = new DeferredStagePort()
    const { user } = await gotoSettingsSurface(port)

    await stageText(user, '项目名称', '销售分析 v2', false)
    await stageText(user, '项目名称', '销售分析 v3', false)

    await waitFor(() => expect(port.pendingStageCount).toBe(1))
    expect(screen.getByRole('button', { name: '应用全部变更' })).toBeDisabled()

    await act(async () => port.releaseNextStage())
    await waitFor(() => expect(port.pendingStageCount).toBe(1))
    expect(screen.getByText('待应用：销售分析 v2')).toBeDefined()
    expect(screen.getByRole('button', { name: '应用全部变更' })).toBeDisabled()

    await act(async () => port.releaseNextStage())
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '项目名称' })).toHaveValue(
        '销售分析 v3'
      )
    )
    expect(screen.getByText('待应用：销售分析 v3')).toBeDefined()
    expect(screen.getByRole('button', { name: '应用全部变更' })).toBeEnabled()

    const snapshot = await port.getSnapshot()
    const projectDraft = snapshot.configurationDrafts.find(
      (draft) => draft.owner.kind === 'project'
    )!
    expect(projectDraft.changes).toContainEqual({
      fieldPath: 'general.name',
      applied: '销售数据分析',
      draft: '销售分析 v3'
    })
  })

  it('queues a pending field edit that returns to the currently shown value', async () => {
    const port = new DeferredStagePort()
    const { user } = await gotoSettingsSurface(port)

    await stageText(user, '项目名称', '临时名称', false)
    await stageText(user, '项目名称', '销售数据分析', false)

    await waitFor(() => expect(port.pendingStageCount).toBe(1))
    await act(async () => port.releaseNextStage())
    await waitFor(() => expect(port.pendingStageCount).toBe(1))
    await act(async () => port.releaseNextStage())
    await waitFor(() =>
      expect(summaryPanel()).toHaveAttribute('aria-busy', 'false')
    )

    expect(screen.getByRole('textbox', { name: '项目名称' })).toHaveValue(
      '销售数据分析'
    )
    expect(within(summaryPanel()).getByText('暂无待应用变更')).toBeDefined()
    const snapshot = await port.getSnapshot()
    expect(
      snapshot.configurationDrafts.some((draft) =>
        draft.changes.some((change) => change.fieldPath === 'general.name')
      )
    ).toBe(false)
  })

  it('keeps a select edit visible so it can be reverted while staging', async () => {
    const port = new DeferredStagePort()
    const { user } = await gotoSettingsSurface(port)

    await user.click(screen.getByRole('button', { name: 'Agent 默认配置' }))
    const provider = screen.getByRole('combobox', { name: '默认 Provider' })
    await user.selectOptions(provider, 'codex')
    expect(provider).toHaveValue('codex')
    await user.selectOptions(provider, 'claude-code')

    await waitFor(() => expect(port.pendingStageCount).toBe(1))
    await act(async () => port.releaseNextStage())
    await waitFor(() => expect(port.pendingStageCount).toBe(1))
    await act(async () => port.releaseNextStage())
    await waitFor(() =>
      expect(summaryPanel()).toHaveAttribute('aria-busy', 'false')
    )

    expect(provider).toHaveValue('claude-code')
    const snapshot = await port.getSnapshot()
    expect(
      snapshot.configurationDrafts.some((draft) =>
        draft.changes.some(
          (change) => change.fieldPath === 'defaults.providerId'
        )
      )
    ).toBe(false)
  })

  it('keeps a queued rejection alert after a later field succeeds', async () => {
    const port = new DeferredStagePort()
    const { user } = await gotoSettingsSurface(port)

    await user.click(screen.getByRole('button', { name: 'Agent 默认配置' }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: '默认 Provider' }),
      'codex'
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: '新建 Agent 打开方式' }),
      'background'
    )

    await waitFor(() => expect(port.pendingStageCount).toBe(1))
    await act(async () => port.rejectNextStage())
    await waitFor(() => expect(port.pendingStageCount).toBe(1))
    await act(async () => port.releaseNextStage())
    await waitFor(() =>
      expect(summaryPanel()).toHaveAttribute('aria-busy', 'false')
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      '字段验证已失效，请重新输入'
    )
    expect(screen.getByText('待应用：后台打开')).toBeDefined()
  })

  it('serializes different fields because they share one global revision', async () => {
    const port = new DeferredStagePort()
    const { user } = await gotoSettingsSurface(port)

    await user.click(screen.getByRole('button', { name: 'Agent 默认配置' }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: '默认 Provider' }),
      'codex'
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: '新建 Agent 打开方式' }),
      'background'
    )

    await waitFor(() => expect(port.pendingStageCount).toBe(1))
    await act(async () => port.releaseNextStage())
    await waitFor(() => expect(port.pendingStageCount).toBe(1))
    await act(async () => port.releaseNextStage())
    expect(port.releasedStageResults).toHaveLength(2)
    expect(port.releasedStageResults.every((result) => result.ok)).toBe(true)
    expect(
      port.releasedStageCommands.map((command) =>
        command.kind === 'stage-configuration'
          ? [command.fieldPath, command.expectedRevision]
          : []
      )
    ).toEqual([
      ['defaults.providerId', 1],
      ['defaults.openMode', 2]
    ])
    expect(
      port.releasedStageResults.map((result) =>
        result.ok ? result.acceptedRevision : -1
      )
    ).toEqual([2, 3])
    await waitFor(() =>
      expect(summaryPanel()).toHaveAttribute('aria-busy', 'false')
    )

    const snapshot = await port.getSnapshot()
    const projectDraft = snapshot.configurationDrafts.find(
      (draft) => draft.owner.kind === 'project'
    )!
    expect(projectDraft.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldPath: 'defaults.providerId',
          draft: 'codex'
        }),
        expect.objectContaining({
          fieldPath: 'defaults.openMode',
          draft: 'background'
        })
      ])
    )
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
    // (#65: the switcher now lives in the shell header, not the nav rail.)
    expect(
      screen.getByRole('combobox', { name: '切换项目' })
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

  it('reports an immediate apply as complete despite an unrelated confirmation', async () => {
    const adapter = new MockScenarioAdapter()
    const initial = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'request-connection-deletion',
      commandId: id('cmd-unrelated-confirmation', 'CommandId'),
      expectedRevision: initial.revision,
      connectionId: initial.global.connections[1].connectionId
    })
    const { user } = await gotoSettingsSurface(adapter)
    await stageText(user, '项目名称', '销售分析 v2')

    await user.click(screen.getByRole('button', { name: '应用全部变更' }))
    const applyDialog = screen.getByRole('dialog', { name: '应用配置变更' })
    await user.click(
      within(applyDialog).getByRole('button', { name: '确认应用' })
    )

    await waitFor(() =>
      expect(within(summaryPanel()).getByText('暂无待应用变更')).toBeDefined()
    )
    expect(screen.getByRole('status')).toHaveTextContent(/已应用/)
    expect(screen.getByText('当前：销售分析 v2（v3）')).toBeDefined()
    expect(
      screen.getByRole('dialog', { name: '删除连接' })
    ).toBeDefined()
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

  it('keeps destructive integration changes pending until the binding impact is confirmed', async () => {
    const { user } = await gotoSettingsSurface()
    await user.click(screen.getByRole('button', { name: '集成' }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: '主连接' }),
      'conn-feishu-product'
    )

    await user.click(screen.getByRole('button', { name: '应用全部变更' }))
    const applyDialog = await screen.findByRole('dialog', {
      name: '应用配置变更'
    })
    await user.click(
      within(applyDialog).getByRole('button', { name: '确认应用' })
    )

    const impactDialog = await screen.findByRole('dialog', {
      name: /集成/
    })
    within(impactDialog).getByText(/销售团队任务清单/)
    within(impactDialog).getByText(/销售知识库/)
    // `ok` means the request was accepted, not that destructive unbinding
    // has committed. Applied rows and drafts remain authoritative here.
    expect(screen.getByRole('status')).toHaveTextContent(/等待确认/)
    expect(screen.getByText('当前：飞书 · 销售团队（v2）')).toBeDefined()
    expect(within(summaryPanel()).queryByText('暂无待应用变更')).toBeNull()

    await user.click(
      within(impactDialog).getByRole('button', { name: '确认' })
    )
    await waitFor(() =>
      expect(within(summaryPanel()).getByText('暂无待应用变更')).toBeDefined()
    )
    expect(screen.getByRole('status')).toHaveTextContent(/已应用/)
    expect(screen.getByText('当前：飞书 · 产品团队（v3）')).toBeDefined()
    expect(screen.getByText('当前：（v3）')).toBeDefined()
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
    await user.selectOptions(
      screen.getByRole('combobox', { name: '切换项目' }),
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
    await user.selectOptions(
      screen.getByRole('combobox', { name: '切换项目' }),
      '用户研究'
    )
    await user.click(screen.getByRole('button', { name: '设置' }))

    // Back to sales (still on Settings) and pick cc_sql again.
    await user.selectOptions(
      screen.getByRole('combobox', { name: '切换项目' }),
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
      screen.getByRole('combobox', { name: '切换项目' }),
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

/**
 * Settings B — the read-only policy matrix (#14). It compares applied
 * configuration across the project's instances and marks adapter-judged
 * blocked values; editing stays in Settings A's sections above.
 */
describe('Settings B — 策略矩阵 (#14)', () => {
  function appliedConfigOf(scenario: WorkbenchViewModel, name: string) {
    const agent = scenario.agents.find((a) => a.name === name)
    if (!agent) throw new Error(`standard scenario has no agent ${name}`)
    const applied = scenario.appliedConfigurations.find(
      (c) =>
        c.owner.kind === 'agent' &&
        c.owner.agentInstanceId === agent.agentInstanceId
    )
    if (!applied) {
      throw new Error(`standard scenario has no applied config for ${name}`)
    }
    return applied
  }

  it('compares the applied values of multiple instances side by side', async () => {
    const scenario = createStandardScenario()
    appliedConfigOf(scenario, 'cc_sql').values['concurrency.priority'] = 'high'
    appliedConfigOf(scenario, 'kimi_visual').values['budget.maxTokens'] = 50000
    const { user } = await gotoSettingsSurface(new MockScenarioAdapter(scenario))
    await user.click(screen.getByRole('button', { name: '策略矩阵' }))

    // Columns: Agent Name primary, Provider display name secondary.
    expect(
      screen.getByRole('columnheader', { name: /cc_sql/ })
    ).toHaveTextContent('Claude Code')
    expect(
      screen.getByRole('columnheader', { name: /kimi_visual/ })
    ).toHaveTextContent('Kimi Code')

    // Rows come from the agent catalogue; identity.name is the column
    // header, never a row.
    expect(
      screen.queryByRole('rowheader', { name: 'Agent 名称' })
    ).not.toBeInTheDocument()
    const priorityCells = within(
      screen.getByRole('row', { name: /优先级/ })
    ).getAllByRole('cell')
    expect(priorityCells.map((cell) => cell.textContent)).toEqual([
      '普通',
      '高',
      '普通',
      '普通',
      '普通',
      '普通',
      '普通',
      '普通'
    ])
    const budgetCells = within(
      screen.getByRole('row', { name: /Token 预算上限/ })
    ).getAllByRole('cell')
    expect(budgetCells.map((cell) => cell.textContent)).toEqual([
      '200000',
      '200000',
      '200000',
      '200000',
      '200000',
      '200000',
      '50000',
      '200000'
    ])
    // An empty applied value renders as 未设置, never a blank cell.
    const proxyCells = within(
      screen.getByRole('row', { name: /HTTP 代理/ })
    ).getAllByRole('cell')
    expect(new Set(proxyCells.map((cell) => cell.textContent))).toEqual(
      new Set(['未设置'])
    )
    // The view marks itself read-only and points editing at Settings A.
    expect(screen.getByText(/只读比较视图/)).toBeInTheDocument()
  })

  it('marks a blocked value with 已阻止 and the adapter-provided reason', async () => {
    const scenario = createStandardScenario()
    const claude = scenario.global.providers.find(
      (p) => p.providerId === 'claude-code'
    )
    if (!claude) throw new Error('standard scenario has no claude-code')
    claude.status = 'blocked'
    const { user } = await gotoSettingsSurface(new MockScenarioAdapter(scenario))
    await user.click(screen.getByRole('button', { name: '策略矩阵' }))

    // The applied value stays visible; the blocked marker and its reason are
    // text, never colour alone.
    const modelRow = screen.getByRole('row', { name: /模型/ })
    const cells = within(modelRow).getAllByRole('cell')
    expect(cells[0]).toHaveTextContent('claude-sonnet-4')
    expect(
      within(modelRow).getAllByText(
        '已阻止：Provider Doctor 未通过，该模型当前无法生效'
      )
    ).toHaveLength(3)
    // Instances of a ready provider carry no blocked marker.
    expect(cells[7]).toHaveTextContent('kimi-k2')
    expect(cells[7]).not.toHaveTextContent('已阻止')
  })

  it('shows a Chinese empty-state hint when the project has fewer than two instances', async () => {
    const scenario = createStandardScenario()
    scenario.agents = scenario.agents.filter(
      (a) => a.projectId !== 'proj-sales' || a.name === 'cc_data'
    )
    const { user } = await gotoSettingsSurface(new MockScenarioAdapter(scenario))
    await user.click(screen.getByRole('button', { name: '策略矩阵' }))
    expect(
      screen.getByText(/只有 1 个 Agent 实例，策略矩阵需要至少 2 个实例进行比较/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument()
  })

  it('shows a Chinese empty-state hint when the project has no instances', async () => {
    const scenario = createStandardScenario()
    scenario.agents = scenario.agents.filter((a) => a.projectId !== 'proj-sales')
    const { user } = await gotoSettingsSurface(new MockScenarioAdapter(scenario))
    await user.click(screen.getByRole('button', { name: '策略矩阵' }))
    expect(
      screen.getByText(/尚无 Agent 实例，暂无可比较的配置/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument()
  })
})

/**
 * Settings C — the read-only next-Run readiness summary (#14). It only
 * summarises adapter-computed runReadiness and links back to the single edit
 * locations (Settings A sections or the global Provider Health surface).
 */
describe('Settings C — Readiness 摘要 (#14)', () => {
  it('summarises per-agent readiness with blocker messages and the honest Phase 1 note', async () => {
    const { user } = await gotoSettingsSurface()
    await user.click(screen.getByRole('button', { name: 'Readiness 摘要' }))

    // kimi_docs is unavailable on a ready provider — the one blocked card.
    // (#66: scoped to main — the context pane also lists kimi_docs.)
    expect(
      within(screen.getByRole('main')).getByText('kimi_docs')
    ).toBeInTheDocument()
    expect(screen.getByText('已阻止')).toBeInTheDocument()
    expect(
      screen.getByText('Agent 当前不可用，修复 Provider 后可恢复')
    ).toBeInTheDocument()
    // Every other instance of the project is ready for its next Run.
    // (#66: scoped to main — the context pane's state-filter <option>
    // also renders a standalone 就绪.)
    expect(
      within(screen.getByRole('main')).getAllByText('就绪')
    ).toHaveLength(7)
    // The view marks itself read-only and stays honest about Phase 1.
    expect(screen.getByText(/只读摘要/)).toBeInTheDocument()
    expect(
      screen.getByText(/Readiness 汇总基于 mock 场景/)
    ).toBeInTheDocument()
    expect(screen.getByText(/不代表真实强制能力/)).toBeInTheDocument()
  })

  it('links a provider-blocked blocker to the global Provider Health surface', async () => {
    const scenario = createStandardScenario()
    const kimi = scenario.global.providers.find(
      (p) => p.providerId === 'kimi-code'
    )
    if (!kimi) throw new Error('standard scenario has no kimi-code')
    kimi.status = 'blocked'
    const { user } = await gotoSettingsSurface(new MockScenarioAdapter(scenario))
    await user.click(screen.getByRole('button', { name: 'Readiness 摘要' }))

    // Both kimi-code instances inherit the provider-blocked blocker.
    expect(
      screen.getAllByText('Provider Doctor 未通过，不能启动新 Run')
    ).toHaveLength(2)
    await user.click(
      screen.getAllByRole('button', { name: '前往 Provider 健康' })[0]
    )
    expect(
      await screen.findByRole('region', { name: 'Provider 健康' })
    ).toBeInTheDocument()
  })

  it('links a project-degradation blocker back to the general settings section', async () => {
    const scenario = createStandardScenario()
    const project = scenario.projects.find((p) => p.projectId === 'proj-sales')
    if (!project) throw new Error('standard scenario has no proj-sales')
    project.repositoryReadiness = 'not-ready'
    const { user } = await gotoSettingsSurface(new MockScenarioAdapter(scenario))
    await user.click(screen.getByRole('button', { name: 'Readiness 摘要' }))

    // Every instance of the project inherits the repository blocker.
    expect(
      screen.getAllByText('Project 尚未初始化或绑定 Git 仓库，不能启动新 Run')
        .length
    ).toBeGreaterThan(0)
    await user.click(
      screen.getAllByRole('button', { name: '前往「常规」设置' })[0]
    )
    // Settings A's general section — the single edit location — appears.
    expect(
      await screen.findByRole('textbox', { name: '项目名称' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '常规' })
    ).toHaveAttribute('aria-current', 'page')
  })

  it('links a model-unavailable blocker to the instances section with the agent selected', async () => {
    const scenario = createStandardScenario()
    const agent = scenario.agents.find((a) => a.name === 'cx_review')
    if (!agent) throw new Error('standard scenario has no cx_review')
    const applied = scenario.appliedConfigurations.find(
      (c) =>
        c.owner.kind === 'agent' &&
        c.owner.agentInstanceId === agent.agentInstanceId
    )
    if (!applied) throw new Error('standard scenario has no cx_review config')
    applied.values['model.id'] = 'gpt-4o'
    const { user } = await gotoSettingsSurface(new MockScenarioAdapter(scenario))
    await user.click(screen.getByRole('button', { name: 'Readiness 摘要' }))

    expect(
      screen.getByText('Codex 不支持模型 "gpt-4o"，请选择兼容模型')
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: '前往「Agent 实例」设置' })
    )
    // The instances editor opens on exactly the offending instance.
    expect(await screen.findByRole('combobox', { name: '选择实例' }))
      .toHaveValue('inst-cx-review')
    expect(screen.getByRole('textbox', { name: '模型' })).toHaveValue('gpt-4o')
  })
})

/**
 * Settings A — permissions enforcement status (#14). The section stays the
 * editor; a read-only block reports the adapter-judged effective status of
 * each permission field. ADR-0012: never claim sandboxing or successful
 * enforcement — whatever cannot be enforced renders as blocked.
 */
describe('Settings A — permissions enforcement status (#14)', () => {
  it('shows the adapter-judged enforcement status with the honest blocked reason', async () => {
    const { user } = await gotoSettingsSurface()
    await user.click(screen.getByRole('button', { name: '权限' }))

    // The editing rows stay untouched: staging still works from the section.
    expect(screen.getByRole('combobox', { name: '默认权限策略' }))
      .toBeInTheDocument()
    // The read-only enforcement block shows the applied value, the
    // adapter-judged status and its reason.
    expect(screen.getByText(/生效状态（只读）/)).toBeInTheDocument()
    expect(screen.getByText('已阻止')).toBeInTheDocument()
    expect(
      screen.getByText(
        'PermissionBroker 尚未接入，策略仅记录为意图，无法强制执行'
      )
    ).toBeInTheDocument()
    // ADR-0012 copy rules: no sandbox / enforced / isolated claims anywhere.
    const region = screen.getByRole('region', { name: '项目设置' })
    expect(region).not.toHaveTextContent(/沙箱|sandbox|已强制|已隔离/i)
    // The old forward-looking placeholder is gone.
    expect(
      screen.queryByText(/有效策略矩阵与下一次 Run 的 readiness/)
    ).not.toBeInTheDocument()
  })
})
