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
import { id } from './workbench/contract'

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

function setPrimaryKnowledgeState(
  snapshot: WorkbenchViewModel,
  state: Exclude<KnowledgeContainerState, 'cached'>
): void {
  const { state: _state, cache: _cache, ...container } = snapshot.knowledge[0]
  snapshot.knowledge[0] = { ...container, state }
}

function setPrimaryKnowledgeCache(
  snapshot: WorkbenchViewModel,
  cache?: KnowledgeCacheViewModel
): void {
  const { state: _state, cache: _cache, ...container } = snapshot.knowledge[0]
  snapshot.knowledge[0] = cache
    ? { ...container, state: 'cached', cache }
    : ({ ...container, state: 'cached' } as unknown as KnowledgeContainerViewModel)
}

function routeAttentionToSecondKnowledgeResource(
  scenario: WorkbenchViewModel
): void {
  const primary = scenario.knowledge[0]
  const { state: _state, cache: _cache, ...sharedBoundary } = primary
  const secondResourceId = id('know-002', 'KnowledgeResourceId')
  scenario.knowledge.push({
    ...sharedBoundary,
    knowledgeResourceId: secondResourceId,
    label: '竞品资料库',
    state: 'online'
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
      expect(surface).toHaveTextContent('Project 本地能力仍然可用')
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

  it('keeps an unconnected Project available and opens global Connections through the port', async () => {
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
      'Project 仍然可用；Agent、Tasks、Activity 与本地 worktree 不受影响'
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
      action: '恢复 Knowledge 连接'
    },
    {
      rejectedKind: 'preview-knowledge-security-event' as const,
      state: 'online' as const,
      action: '模拟下载'
    }
  ])(
    'surfaces $rejectedKind rejection reason with retry and recovery actions',
    async ({ rejectedKind, state, action }) => {
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
        name: 'Knowledge 操作失败'
      })
      expect(failure).toHaveTextContent('当前不可用')
      expect(failure).not.toHaveTextContent('unavailable')
      expect(failure).toHaveTextContent('Knowledge 测试连接当前不可用')
      expect(
        within(failure).getByRole('button', { name: '重试上次操作' })
      ).toBeEnabled()
      expect(
        within(failure).getByRole('button', {
          name: '检查全局 Connections'
        })
      ).toBeEnabled()

      await user.click(
        within(failure).getByRole('button', { name: '重试上次操作' })
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

  it('uses safe Chinese recovery copy instead of exposing transport errors', async () => {
    const user = userEvent.setup()
    render(<ProjectShell port={new ThrowingKnowledgeAdapter()} />)

    await user.click(await screen.findByRole('button', { name: '知识' }))
    const surface = await screen.findByRole('region', { name: 'Knowledge' })
    await user.click(
      within(surface).getByRole('button', { name: '模拟下载' })
    )

    const failure = await within(surface).findByRole('alert', {
      name: 'Knowledge 操作失败'
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
      name: 'Knowledge 操作失败'
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
        name: 'Knowledge 操作失败'
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
        name: 'Knowledge 操作失败'
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
        name: 'Knowledge 操作失败'
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
        name: 'Knowledge 操作失败'
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
