// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'
import {
  createKnowledgeBoundaryScenario,
  createStandardScenario
} from './workbench/standard-scenario'
import type {
  CommandResult,
  KnowledgeCacheViewModel,
  KnowledgeContainerState,
  KnowledgeContainerViewModel,
  WorkbenchCommand,
  WorkbenchViewModel
} from './workbench/contract'
import { id, stripKnowledgeContainerState } from './workbench/contract'

class RejectingKnowledgeAdapter extends MockScenarioAdapter {
  constructor(
    snapshot: WorkbenchViewModel,
    private readonly rejectedKind:
      | 'recover-knowledge-connection'
      | 'preview-knowledge-security-event'
  ) {
    super(snapshot)
  }

  override async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    if (command.kind !== this.rejectedKind) {
      return super.dispatch(command)
    }
    return {
      ok: false,
      commandId: command.commandId,
      reason: 'unavailable',
      latestRevision: command.expectedRevision,
      message: 'Knowledge 测试连接当前不可用'
    }
  }
}

class RejectingConcurrentKnowledgeAdapter extends MockScenarioAdapter {
  override async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    if (
      command.kind !== 'recover-knowledge-connection' &&
      command.kind !== 'preview-knowledge-security-event'
    ) {
      return super.dispatch(command)
    }
    return {
      ok: false,
      commandId: command.commandId,
      reason: 'unavailable',
      latestRevision: command.expectedRevision,
      message:
        command.kind === 'recover-knowledge-connection'
          ? 'Knowledge 恢复连接失败'
          : 'Knowledge 安全演练失败'
    }
  }
}

class ThrowingKnowledgeAdapter extends MockScenarioAdapter {
  constructor(
    private readonly throwingKind:
      | 'preview-knowledge-security-event'
      | 'navigate-global' = 'preview-knowledge-security-event'
  ) {
    super()
  }

  override async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    if (command.kind === this.throwingKind) {
      throw new Error('ECONNRESET from internal transport')
    }
    return super.dispatch(command)
  }
}

class DeferredRejectingKnowledgeAdapter extends MockScenarioAdapter {
  private pending?: {
    command: WorkbenchCommand
    resolve: (result: CommandResult) => void
  }

  override dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    if (command.kind !== 'preview-knowledge-security-event') {
      return super.dispatch(command)
    }
    return new Promise((resolve) => {
      this.pending = { command, resolve }
    })
  }

  rejectPendingSecurityCommand(): void {
    if (!this.pending) throw new Error('no pending Knowledge command')
    const { command, resolve } = this.pending
    this.pending = undefined
    resolve({
      ok: false,
      commandId: command.commandId,
      reason: 'unavailable',
      latestRevision: command.expectedRevision,
      message: 'Knowledge 测试连接当前不可用'
    })
  }
}

class DeferredRejectingRecoveryAdapter extends MockScenarioAdapter {
  private pending?: {
    command: WorkbenchCommand
    resolve: (result: CommandResult) => void
  }

  override dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    if (command.kind !== 'recover-knowledge-connection') {
      return super.dispatch(command)
    }
    return new Promise((resolve) => {
      this.pending = { command, resolve }
    })
  }

  rejectPendingRecovery(): void {
    if (!this.pending) throw new Error('no pending Knowledge recovery')
    const { command, resolve } = this.pending
    this.pending = undefined
    resolve({
      ok: false,
      commandId: command.commandId,
      reason: 'unavailable',
      latestRevision: command.expectedRevision,
      message: 'Knowledge 恢复连接失败'
    })
  }
}

class EventFirstKnowledgeNavigationAdapter extends MockScenarioAdapter {
  private releaseNavigationResult?: () => void

  override async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    const result = await super.dispatch(command)
    if (command.kind !== 'navigate' || command.surface !== 'knowledge') {
      return result
    }
    return new Promise((resolve) => {
      this.releaseNavigationResult = () => resolve(result)
    })
  }

  releaseKnowledgeNavigation(): void {
    if (!this.releaseNavigationResult) {
      throw new Error('Knowledge navigation Result is not pending')
    }
    const release = this.releaseNavigationResult
    this.releaseNavigationResult = undefined
    release()
  }
}

type DeferredKnowledgeRaceResult = 'tasks' | 'knowledge' | 'agent-layout'

class DeferredKnowledgeRaceAdapter extends MockScenarioAdapter {
  private releases = new Map<DeferredKnowledgeRaceResult, () => void>()

  override async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    const result = await super.dispatch(command)
    if (command.kind === 'change-layout') {
      return new Promise((resolve) => {
        this.releases.set('agent-layout', () => resolve(result))
      })
    }
    if (
      command.kind !== 'navigate' ||
      (command.surface !== 'tasks' && command.surface !== 'knowledge')
    ) {
      return result
    }
    const surface = command.surface
    return new Promise((resolve) => {
      this.releases.set(surface, () => resolve(result))
    })
  }

  hasPending(result: DeferredKnowledgeRaceResult): boolean {
    return this.releases.has(result)
  }

  releaseResult(result: DeferredKnowledgeRaceResult): void {
    const release = this.releases.get(result)
    if (!release) throw new Error(`${result} Result is not pending`)
    this.releases.delete(result)
    release()
  }
}

class ThrowingKnowledgeNavigationAdapter extends MockScenarioAdapter {
  override dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    if (command.kind === 'navigate' && command.surface === 'knowledge') {
      return Promise.reject(new Error('ECONNRESET from internal transport'))
    }
    return super.dispatch(command)
  }
}

function setPrimaryKnowledgeState(
  snapshot: WorkbenchViewModel,
  state: Exclude<KnowledgeContainerState, 'cached'>
): void {
  const container = stripKnowledgeContainerState(snapshot.knowledge[0])
  snapshot.knowledge[0] = { ...container, state }
}

function setPrimaryKnowledgeCache(
  snapshot: WorkbenchViewModel,
  cache?: KnowledgeCacheViewModel
): void {
  const container = stripKnowledgeContainerState(snapshot.knowledge[0])
  snapshot.knowledge[0] = cache
    ? { ...container, state: 'cached', cache }
    : ({ ...container, state: 'cached' } as unknown as KnowledgeContainerViewModel)
}

function routeAttentionToSecondKnowledgeResource(
  scenario: WorkbenchViewModel
): void {
  const primary = scenario.knowledge[0]
  const { unsyncedChanges, ...sharedBoundary } =
    stripKnowledgeContainerState(primary)
  delete primary.unsyncedChanges
  const secondResourceId = id('know-002', 'KnowledgeResourceId')
  scenario.knowledge.push({
    ...sharedBoundary,
    knowledgeResourceId: secondResourceId,
    label: '竞品资料库',
    state: 'online',
    unsyncedChanges
  })
  const attention = scenario.attentionItems.find(
    (item) => item.target.kind === 'knowledge'
  )!
  if (attention.target.kind !== 'knowledge') {
    throw new Error('invalid Knowledge attention fixture')
  }
  attention.target.knowledgeResourceId = secondResourceId
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Knowledge surface — browser and identity boundaries (#11)', () => {
  it('shows the online browser container and keeps every identity boundary explicit', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter()} />)

    await user.click(await screen.findByRole('button', { name: '知识' }))

    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    expect(
      within(surface).getByRole('heading', { name: '销售知识库' })
    ).toBeVisible()
    expect(surface).toHaveTextContent('受控浏览器容器')
    expect(surface).toHaveTextContent('在线')
    const chrome = within(surface).getByRole('toolbar', {
      name: 'Knowledge 浏览器 chrome'
    })
    expect(
      within(chrome).getByRole('button', { name: '后退' })
    ).toBeDisabled()
    expect(
      within(chrome).getByRole('button', { name: '前进' })
    ).toBeDisabled()
    expect(
      within(chrome).getByRole('button', { name: '刷新' })
    ).toBeDisabled()
    expect(
      within(chrome).getByRole('textbox', { name: '当前受控位置' })
    ).toHaveValue('销售知识库（契约化 Mock）')
    expect(surface).toHaveTextContent('人工浏览器身份：林晓（销售团队）')
    expect(surface).toHaveTextContent(
      'Connector 执行身份：Agent Squad HQ Connector（销售团队应用）'
    )
    expect(surface).toHaveTextContent('ConnectionId：conn-feishu-primary')
    expect(surface).toHaveTextContent(
      'Project Resource Binding：销售知识库'
    )
    expect(surface).toHaveTextContent(
      'ResourceBindingId：binding-sales-wiki'
    )
    expect(surface).toHaveTextContent('窄化操作范围：读取、更新')
    expect(surface).toHaveTextContent(
      '人工浏览器身份与 Connector 执行身份严格隔离'
    )
    expect(surface).toHaveTextContent(
      '不共享 Cookie、Token、浏览器 profile 或鉴权材料'
    )
  })

  it.each([
    {
      state: 'offline' as const,
      status: '离线',
      feedback: '实时内容离线，且没有可用缓存',
      action: '恢复 Knowledge 连接'
    },
    {
      state: 'unavailable' as const,
      status: '不可用',
      feedback: 'Knowledge 容器当前不可用',
      action: '检查全局 Connections'
    }
  ])(
    'shows an actionable $state state without presenting stale content as live',
    async ({ state, status, feedback, action }) => {
      const scenario = createStandardScenario()
      setPrimaryKnowledgeState(scenario, state)
      const user = userEvent.setup()
      render(<ProjectShell port={new MockScenarioAdapter(scenario)} />)

      await user.click(await screen.findByRole('button', { name: '知识' }))

      const surface = await screen.findByRole('region', { name: 'Knowledge' })
      expect(within(surface).getByRole('status')).toHaveTextContent(status)
      expect(surface).toHaveTextContent(feedback)
      expect(surface).toHaveTextContent(
        'Knowledge 连接状态不会自行改变 Project 生命周期、Root 可用性'
      )
      expect(
        within(surface).getByRole('button', { name: action })
      ).toBeEnabled()
      if (state === 'unavailable') {
        expect(
          within(surface).queryByRole('button', {
            name: '恢复 Knowledge 连接'
          })
        ).toBeNull()
      }
    }
  )

  it('marks offline cached content as read-only and shows its version and cached time', async () => {
    const scenario = createKnowledgeBoundaryScenario(
      Date.parse('2026-08-03T11:10:00.000Z')
    )
    const cached = scenario.knowledge.find(
      (container) => container.state === 'cached'
    )!
    const attention = scenario.attentionItems.find(
      (item) => item.target.kind === 'knowledge'
    )!
    if (attention.target.kind !== 'knowledge') {
      throw new Error('invalid Knowledge attention fixture')
    }
    attention.target.knowledgeResourceId = cached.knowledgeResourceId!
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter(scenario)} />)

    await user.click(
      await screen.findByRole('button', { name: 'Global Attention' })
    )
    const drawer = await screen.findByRole('complementary', {
      name: 'Global Attention'
    })
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：销售知识库有未同步的修改'
      })
    )

    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    expect(within(surface).getByRole('status')).toHaveTextContent('离线缓存')
    expect(surface).toHaveTextContent('只读')
    expect(surface).toHaveTextContent('缓存版本：sales-playbook-v7')
    expect(surface).toHaveTextContent('缓存时间：2026-08-03 10:40 UTC')
    expect(surface).toHaveTextContent('禁止编辑与写入')
  })

  it('fails closed when cached-time metadata is invalid instead of crashing the surface', async () => {
    const scenario = createStandardScenario()
    setPrimaryKnowledgeCache(scenario, {
      version: 'wiki-v43',
      cachedAt: Number.NaN,
      readOnly: true
    })
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter(scenario)} />)

    await user.click(await screen.findByRole('button', { name: '知识' }))

    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    expect(within(surface).getByRole('status')).toHaveTextContent('不可用')
    expect(surface).toHaveTextContent(
      '缓存元数据不完整，不能作为有效离线缓存展示'
    )
    expect(surface).not.toHaveTextContent('缓存版本：wiki-v43')
  })

  it('fails closed when a cached projection omits mandatory metadata', async () => {
    const scenario = createStandardScenario()
    setPrimaryKnowledgeCache(scenario)
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter(scenario)} />)

    await user.click(await screen.findByRole('button', { name: '知识' }))

    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    expect(within(surface).getByRole('status')).toHaveTextContent('不可用')
    expect(surface).toHaveTextContent(
      '缓存元数据不完整，不能作为有效离线缓存展示'
    )
    expect(surface).not.toHaveTextContent('离线缓存仅供只读')
  })

  it('ships a reusable offline-cache projection in the Knowledge boundary scenario', () => {
    const cached = createKnowledgeBoundaryScenario().knowledge.find(
      (container) => container.state === 'cached'
    )

    expect(cached).toMatchObject({
      state: 'cached',
      cache: {
        version: expect.any(String),
        cachedAt: expect.any(Number),
        readOnly: true
      }
    })
  })

  it('keeps Knowledge connection state orthogonal and opens global Connections through the port', async () => {
    const port = new MockScenarioAdapter()
    const dispatch = vi.spyOn(port, 'dispatch')
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)

    await user.selectOptions(
      await screen.findByLabelText('切换项目'),
      'proj-research'
    )
    await user.click(screen.getByRole('button', { name: '知识' }))

    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    expect(within(surface).getByRole('status')).toHaveTextContent('未连接')
    expect(surface).toHaveTextContent('尚未配置 Knowledge 主连接')
    expect(surface).toHaveTextContent(
      'Knowledge 连接状态不会自行改变 Project 生命周期、Root 可用性'
    )
    expect(surface).toHaveTextContent(
      '仍可使用 Agents、本地 Tasks、Handoffs 与 Activity'
    )

    await user.click(
      within(surface).getByRole('button', { name: '前往全局 Connections' })
    )

    expect(await screen.findByRole('region', { name: '全局连接' })).toBeVisible()
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'navigate-global',
        surface: 'connections'
      })
    )
  })

  it('does not overwrite archived or unavailable Project state in Knowledge degradation copy', async () => {
    const scenario = createStandardScenario()
    const project = scenario.projects.find(
      (candidate) => candidate.projectId === 'proj-research'
    )!
    project.lifecycle = 'archived'
    project.rootAvailability = 'unavailable'
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter(scenario)} />)

    await user.selectOptions(
      await screen.findByLabelText('切换项目'),
      'proj-research'
    )
    await user.click(screen.getByRole('button', { name: '知识' }))

    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    expect(within(surface).getByRole('status')).toHaveTextContent('未连接')
    expect(surface).toHaveTextContent(
      'Knowledge 连接状态不会自行改变 Project 生命周期、Root 可用性'
    )
    expect(surface).not.toHaveTextContent('Project 仍然可用')
    expect(surface).not.toHaveTextContent('Project 本地能力仍然可用')
    expect(surface).not.toHaveTextContent('不受影响')
    expect(surface).not.toHaveTextContent(
      '仍可使用 Agents、本地 Tasks、Handoffs 与 Activity'
    )
  })

  it('previews each browser security decision through the port without external side effects', async () => {
    const port = new MockScenarioAdapter()
    const dispatch = vi.spyOn(port, 'dispatch')
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)

    await user.click(await screen.findByRole('button', { name: '知识' }))
    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    expect(surface).toHaveTextContent(
      'Phase 1 安全演练不创建 BrowserView、partition，不发起真实导航或网络请求'
    )

    const cases = [
      {
        button: '模拟不受信任链接',
        action: 'untrusted-link',
        feedback:
          '已阻止容器内导航；预期由系统浏览器处理，本阶段未打开链接'
      },
      {
        button: '模拟下载',
        action: 'download',
        feedback: '已阻止下载；本阶段未创建文件'
      },
      {
        button: '模拟弹窗',
        action: 'popup',
        feedback: '已阻止弹窗；本阶段未创建新窗口'
      },
      {
        button: '模拟浏览器权限请求',
        action: 'permission-request',
        feedback: '已拒绝浏览器权限请求；本阶段未授予权限'
      }
    ] as const

    for (const expected of cases) {
      await user.click(
        within(surface).getByRole('button', { name: expected.button })
      )
      await waitFor(() =>
        expect(
          within(surface).getByRole('status', {
            name: '浏览器安全反馈'
          })
        ).toHaveTextContent(expected.feedback)
      )
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'preview-knowledge-security-event',
          action: expected.action
        })
      )
    }

    expect(open).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('recovers an offline Knowledge connection through an authoritative port transition', async () => {
    const scenario = createStandardScenario()
    setPrimaryKnowledgeState(scenario, 'offline')
    scenario.global.connections[0].status = 'offline'
    const port = new MockScenarioAdapter(scenario)
    const dispatch = vi.spyOn(port, 'dispatch')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)

    await user.click(await screen.findByRole('button', { name: '知识' }))
    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    expect(within(surface).getByRole('status')).toHaveTextContent('离线')

    await user.click(
      within(surface).getByRole('button', { name: '恢复 Knowledge 连接' })
    )

    await waitFor(() =>
      expect(within(surface).getByRole('status')).toHaveTextContent('在线')
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'recover-knowledge-connection',
        projectId: 'proj-sales',
        knowledgeResourceId: 'know-001'
      })
    )
    expect((await port.getSnapshot()).global.connections[0].status).toBe(
      'connected'
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    {
      rejectedKind: 'recover-knowledge-connection' as const,
      state: 'offline' as const,
      action: '恢复 Knowledge 连接',
      failureName: 'Knowledge 恢复连接失败',
      retryName: '重试恢复连接'
    },
    {
      rejectedKind: 'preview-knowledge-security-event' as const,
      state: 'online' as const,
      action: '模拟下载',
      failureName: 'Knowledge 安全演练失败',
      retryName: '重试安全演练'
    }
  ])(
    'surfaces $rejectedKind rejection reason with retry and recovery actions',
    async ({ rejectedKind, state, action, failureName, retryName }) => {
      const scenario = createStandardScenario()
      setPrimaryKnowledgeState(scenario, state)
      const port = new RejectingKnowledgeAdapter(scenario, rejectedKind)
      const dispatch = vi.spyOn(port, 'dispatch')
      const user = userEvent.setup()
      render(<ProjectShell port={port} />)

      await user.click(await screen.findByRole('button', { name: '知识' }))
      const surface = await screen.findByRole('region', {
        name: 'Knowledge'
      })
      await user.click(within(surface).getByRole('button', { name: action }))

      const failure = await within(surface).findByRole('alert', {
        name: failureName
      })
      expect(failure).toHaveTextContent('当前不可用')
      expect(failure).not.toHaveTextContent('unavailable')
      expect(failure).toHaveTextContent('Knowledge 测试连接当前不可用')
      expect(
        within(failure).getByRole('button', { name: retryName })
      ).toBeEnabled()
      expect(
        within(failure).getByRole('button', {
          name: '检查全局 Connections'
        })
      ).toBeEnabled()

      await user.click(
        within(failure).getByRole('button', { name: retryName })
      )
      await waitFor(() =>
        expect(
          dispatch.mock.calls.filter(
            ([command]) => command.kind === rejectedKind
          )
        ).toHaveLength(2)
      )
    }
  )

  it('gives concurrent operation failures distinct accessible retry targets', async () => {
    const scenario = createStandardScenario()
    setPrimaryKnowledgeState(scenario, 'offline')
    const user = userEvent.setup()
    render(
      <ProjectShell port={new RejectingConcurrentKnowledgeAdapter(scenario)} />
    )

    await user.click(await screen.findByRole('button', { name: '知识' }))
    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    await user.click(
      within(surface).getByRole('button', { name: '恢复 Knowledge 连接' })
    )
    await user.click(
      within(surface).getByRole('button', { name: '模拟下载' })
    )

    const recoveryFailure = await within(surface).findByRole('alert', {
      name: 'Knowledge 恢复连接失败'
    })
    const securityFailure = within(surface).getByRole('alert', {
      name: 'Knowledge 安全演练失败'
    })
    expect(recoveryFailure).toHaveTextContent('Knowledge 恢复连接失败')
    expect(securityFailure).toHaveTextContent('Knowledge 安全演练失败')
    expect(
      within(recoveryFailure).getByRole('button', { name: '重试恢复连接' })
    ).toBeEnabled()
    expect(
      within(securityFailure).getByRole('button', { name: '重试安全演练' })
    ).toBeEnabled()
  })

  it('keeps a delayed recovery failure when an unrelated security action succeeds', async () => {
    const scenario = createStandardScenario()
    setPrimaryKnowledgeState(scenario, 'offline')
    const port = new DeferredRejectingRecoveryAdapter(scenario)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)

    await user.click(await screen.findByRole('button', { name: '知识' }))
    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    await user.click(
      within(surface).getByRole('button', { name: '恢复 Knowledge 连接' })
    )
    await user.click(
      within(surface).getByRole('button', { name: '模拟下载' })
    )
    expect(
      await within(surface).findByRole('status', {
        name: '浏览器安全反馈'
      })
    ).toHaveTextContent('已阻止下载')

    await act(async () => {
      port.rejectPendingRecovery()
      await Promise.resolve()
    })

    expect(
      await within(surface).findByRole('alert', {
        name: 'Knowledge 恢复连接失败'
      })
    ).toHaveTextContent('Knowledge 恢复连接失败')
  })

  it('uses safe Chinese recovery copy instead of exposing transport errors', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new ThrowingKnowledgeAdapter()} />)

    await user.click(await screen.findByRole('button', { name: '知识' }))
    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    await user.click(
      within(surface).getByRole('button', { name: '模拟下载' })
    )

    const failure = await within(surface).findByRole('alert', {
      name: 'Knowledge 安全演练失败'
    })
    expect(failure).toHaveTextContent('通信失败')
    expect(failure).toHaveTextContent('命令传输失败，请重试')
    expect(failure).not.toHaveTextContent('ECONNRESET')
    expect(failure).not.toHaveTextContent('transport-error')
  })

  it('settles a failed Connections navigation and shows safe recovery feedback', async () => {
    const user = userEvent.setup()
    render(
      <ProjectShell port={new ThrowingKnowledgeAdapter('navigate-global')} />
    )

    await user.selectOptions(
      await screen.findByLabelText('切换项目'),
      'proj-research'
    )
    await user.click(screen.getByRole('button', { name: '知识' }))
    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    await user.click(
      within(surface).getByRole('button', {
        name: '前往全局 Connections'
      })
    )

    const failure = await within(surface).findByRole('alert', {
      name: 'Knowledge 全局 Connections 导航失败'
    })
    expect(failure).toHaveTextContent('通信失败')
    expect(failure).toHaveTextContent('命令传输失败，请重试')
    expect(screen.queryByRole('region', { name: '全局连接' })).toBeNull()
  })

  it('drops a rejected action when a deep link changes the current Knowledge resource', async () => {
    const scenario = createStandardScenario()
    routeAttentionToSecondKnowledgeResource(scenario)
    const user = userEvent.setup()
    render(
      <ProjectShell
        port={
          new RejectingKnowledgeAdapter(
            scenario,
            'preview-knowledge-security-event'
          )
        }
      />
    )

    await user.click(await screen.findByRole('button', { name: '知识' }))
    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    await user.click(
      within(surface).getByRole('button', { name: '模拟下载' })
    )
    expect(
      await within(surface).findByRole('alert', {
        name: 'Knowledge 安全演练失败'
      })
    ).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Global Attention' }))
    const drawer = await screen.findByRole('complementary', {
      name: 'Global Attention'
    })
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：销售知识库有未同步的修改'
      })
    )

    const updatedSurface = await screen.findByRole('region', {
      name: 'Knowledge'
    })
    expect(
      await within(updatedSurface).findByRole('article', {
        name: '当前知识资源：竞品资料库'
      })
    ).toHaveTextContent('KnowledgeResourceId：know-002')
    expect(
      within(updatedSurface).queryByRole('alert', {
        name: 'Knowledge 安全演练失败'
      })
    ).toBeNull()
  })

  it('ignores a late rejection after a deep link changes the stable Knowledge target', async () => {
    const scenario = createStandardScenario()
    routeAttentionToSecondKnowledgeResource(scenario)
    const port = new DeferredRejectingKnowledgeAdapter(scenario)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)

    await user.click(await screen.findByRole('button', { name: '知识' }))
    const initialSurface = await screen.findByRole('region', {
      name: 'Knowledge'
    })
    await user.click(
      within(initialSurface).getByRole('button', { name: '模拟下载' })
    )
    expect(
      within(initialSurface).queryByRole('alert', {
        name: 'Knowledge 安全演练失败'
      })
    ).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Global Attention' }))
    const drawer = await screen.findByRole('complementary', {
      name: 'Global Attention'
    })
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：销售知识库有未同步的修改'
      })
    )
    const updatedSurface = await screen.findByRole('region', {
      name: 'Knowledge'
    })
    expect(
      await within(updatedSurface).findByRole('article', {
        name: '当前知识资源：竞品资料库'
      })
    ).toHaveTextContent('KnowledgeResourceId：know-002')

    await act(async () => {
      port.rejectPendingSecurityCommand()
      await Promise.resolve()
    })
    expect(
      within(updatedSurface).queryByRole('alert', {
        name: 'Knowledge 安全演练失败'
      })
    ).toBeNull()
  })

  it('deep-links Attention to the exact stable KnowledgeResourceId', async () => {
    const scenario = createStandardScenario()
    const project = scenario.projects[0]
    const connectionId = project.primaryConnectionId!
    const secondBindingId = id(
      'binding-competitor-wiki',
      'ResourceBindingId'
    )
    project.resourceBindings.push({
      bindingId: secondBindingId,
      connectionId,
      resourceType: 'knowledge-space',
      label: '竞品资料库',
      allowedOperations: ['read']
    })
    scenario.knowledge.unshift({
      projectId: project.projectId,
      knowledgeResourceId: id('know-002', 'KnowledgeResourceId'),
      label: '竞品资料库',
      state: 'online',
      humanBrowserIdentity: '林晓（销售团队）',
      connectionId,
      connectorIdentity: 'Agent Squad HQ Connector（销售团队应用）',
      resourceBindingId: secondBindingId
    })
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter(scenario)} />)

    await user.click(
      await screen.findByRole('button', { name: 'Global Attention' })
    )
    const drawer = await screen.findByRole('complementary', {
      name: 'Global Attention'
    })
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：销售知识库有未同步的修改'
      })
    )

    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    const current = await within(surface).findByRole('article', {
      name: '当前知识资源：销售知识库'
    })
    expect(current).toHaveTextContent('KnowledgeResourceId：know-001')
    expect(current).not.toHaveTextContent('竞品资料库')
    expect(surface).not.toHaveTextContent('详情尚未交付')
  })

  it('locks the Attention Knowledge target while its accepted navigation Result is delayed', async () => {
    const scenario = createStandardScenario()
    routeAttentionToSecondKnowledgeResource(scenario)
    const port = new EventFirstKnowledgeNavigationAdapter(scenario)
    const dispatch = vi.spyOn(port, 'dispatch')
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)

    await user.click(
      await screen.findByRole('button', { name: 'Global Attention' })
    )
    const drawer = await screen.findByRole('complementary', {
      name: 'Global Attention'
    })
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：销售知识库有未同步的修改'
      })
    )

    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    expect(
      await within(surface).findByRole('article', {
        name: '当前知识资源：竞品资料库'
      })
    ).toHaveTextContent('KnowledgeResourceId：know-002')
    await user.click(
      within(surface).getByRole('button', { name: '模拟下载' })
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'preview-knowledge-security-event',
        knowledgeResourceId: 'know-002'
      })
    )

    await act(async () => {
      port.releaseKnowledgeNavigation()
      await Promise.resolve()
    })
  })

  it('keeps a newer pending Knowledge target when an older explicit navigation succeeds late', async () => {
    const scenario = createStandardScenario()
    routeAttentionToSecondKnowledgeResource(scenario)
    const port = new DeferredKnowledgeRaceAdapter(scenario)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)

    await user.click(await screen.findByRole('button', { name: '任务' }))
    expect(await screen.findByText(/任务 工作面尚未实现/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Global Attention' }))
    const drawer = await screen.findByRole('complementary', {
      name: 'Global Attention'
    })
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：销售知识库有未同步的修改'
      })
    )

    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    expect(
      await within(surface).findByRole('article', {
        name: '当前知识资源：竞品资料库'
      })
    ).toHaveTextContent('KnowledgeResourceId：know-002')

    await act(async () => {
      port.releaseResult('tasks')
      await Promise.resolve()
    })

    const currentSurface = screen.getByRole('region', { name: 'Knowledge' })
    expect(
      within(currentSurface).getByRole('article', {
        name: '当前知识资源：竞品资料库'
      })
    ).toHaveTextContent('KnowledgeResourceId：know-002')
    expect(
      within(currentSurface).queryByRole('article', {
        name: '当前知识资源：销售知识库'
      })
    ).toBeNull()

    await act(async () => {
      port.releaseResult('knowledge')
      await Promise.resolve()
    })
  })

  it('keeps a newer pending Knowledge target while an older Agent layout settles', async () => {
    const scenario = createStandardScenario()
    routeAttentionToSecondKnowledgeResource(scenario)
    const port = new DeferredKnowledgeRaceAdapter(scenario)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)

    await user.click(
      await screen.findByRole('button', { name: 'Global Attention' })
    )
    let drawer = await screen.findByRole('complementary', {
      name: 'Global Attention'
    })
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：cc_sql 等待输入：确认 6 月数据口径'
      })
    )
    await waitFor(() => expect(port.hasPending('agent-layout')).toBe(true))

    await user.click(screen.getByRole('button', { name: 'Global Attention' }))
    drawer = await screen.findByRole('complementary', {
      name: 'Global Attention'
    })
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：销售知识库有未同步的修改'
      })
    )

    expect(
      await screen.findByRole('article', {
        name: '当前知识资源：竞品资料库'
      })
    ).toHaveTextContent('KnowledgeResourceId：know-002')

    await act(async () => {
      port.releaseResult('agent-layout')
      await Promise.resolve()
    })

    expect(
      screen.getByRole('article', {
        name: '当前知识资源：竞品资料库'
      })
    ).toHaveTextContent('KnowledgeResourceId：know-002')
    expect(
      screen.queryByRole('article', {
        name: '当前知识资源：销售知识库'
      })
    ).toBeNull()

    await act(async () => {
      port.releaseResult('knowledge')
      await Promise.resolve()
    })
  })

  it('restores the prior Knowledge target after deep-link transport failure', async () => {
    const scenario = createStandardScenario()
    routeAttentionToSecondKnowledgeResource(scenario)
    scenario.projects[0].currentSurface = 'knowledge'
    const user = userEvent.setup()
    render(
      <ProjectShell port={new ThrowingKnowledgeNavigationAdapter(scenario)} />
    )

    expect(
      await screen.findByRole('article', {
        name: '当前知识资源：销售知识库'
      })
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Global Attention' }))
    const drawer = await screen.findByRole('complementary', {
      name: 'Global Attention'
    })
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：销售知识库有未同步的修改'
      })
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '无法打开目标：导航命令传输失败，请重试'
    )
    expect(
      screen.getByRole('article', { name: '当前知识资源：销售知识库' })
    ).toBeVisible()
    expect(
      screen.queryByRole('article', { name: '当前知识资源：竞品资料库' })
    ).toBeNull()
  })

  it('surfaces a missing Knowledge deep-link target instead of falling back to another resource', async () => {
    const scenario = createStandardScenario()
    const item = scenario.attentionItems.find(
      (candidate) => candidate.target.kind === 'knowledge'
    )!
    if (item.target.kind !== 'knowledge') throw new Error('invalid fixture')
    item.target.knowledgeResourceId = id(
      'know-missing',
      'KnowledgeResourceId'
    )
    const user = userEvent.setup()
    render(<ProjectShell port={new MockScenarioAdapter(scenario)} />)

    await user.click(
      await screen.findByRole('button', { name: 'Global Attention' })
    )
    const drawer = await screen.findByRole('complementary', {
      name: 'Global Attention'
    })
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：销售知识库有未同步的修改'
      })
    )

    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    expect(await within(surface).findByRole('alert')).toHaveTextContent(
      '无法打开 Knowledge 目标：know-missing 不存在或已解除绑定'
    )
    expect(within(surface).queryByRole('article')).toBeNull()
  })
})
