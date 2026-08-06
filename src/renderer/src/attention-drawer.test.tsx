// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
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
import { createStandardScenario } from './workbench/standard-scenario'
import { id } from './workbench/contract'
import type {
  CommandResult,
  WorkbenchCommand,
  WorkbenchEvent,
  WorkbenchViewModel
} from './workbench/contract'

afterEach(() => cleanup())

type User = ReturnType<typeof userEvent.setup>

async function renderShell(scenario?: WorkbenchViewModel) {
  const snapshot = scenario ?? createStandardScenario()
  if (!scenario) {
    snapshot.activeGlobalSurface = undefined
    snapshot.projects[0].currentSurface = 'overview'
  }
  const adapter = new MockScenarioAdapter(
    snapshot
  )
  const user = userEvent.setup()
  render(<ProjectShell port={adapter} />)
  await screen.findByRole('button', { name: '概览' })
  return { user, adapter }
}

async function openDrawer(user: User) {
  let overview = screen.queryByRole('region', { name: '项目概览' })
  if (!overview) {
    await user.click(await screen.findByRole('button', { name: '概览' }))
    overview = await screen.findByRole('region', { name: '项目概览' })
  }
  const trigger = within(overview).getAllByRole('button', { name: '打开' })[0]
  await user.click(trigger)
  const drawer = await screen.findByRole('complementary', {
    name: 'Global Attention'
  })
  return { trigger, drawer }
}

/** #75: project switching lives in the persistent top switch bar. */
function switchBar() {
  return screen.getByRole('navigation', { name: '快捷切换' })
}

async function switchToProject(user: User, name: '销售数据分析' | '用户研究') {
  await user.click(within(switchBar()).getByRole('button', { name }))
}

/** The current project is the bar button carrying aria-current. */
function expectCurrentProject(name: string) {
  expect(
    within(switchBar()).getByRole('button', { name })
  ).toHaveAttribute('aria-current', 'page')
}

describe('Global Attention — shell entry (#9)', () => {
  it('does not expose a persistent Attention shortcut in the statusbar', async () => {
    await renderShell()
    expect(
      within(
        screen.getByRole('navigation', { name: '全局快捷入口' })
      ).queryByRole('button', { name: 'Global Attention' })
    ).toBeNull()
  })

  it('opens from a contextual Overview processing action', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    expect(drawer).toBeVisible()
    await user.keyboard('{Escape}')
    expect(
      screen.queryByRole('complementary', { name: 'Global Attention' })
    ).toBeNull()
  })

  it('moves focus into the drawer and restores it to the opener', async () => {
    const { user } = await renderShell()
    const { trigger, drawer } = await openDrawer(user)
    const close = within(drawer).getByRole('button', { name: '关闭' })
    expect(close).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
  })
})

describe('Global Attention — aggregation (#9)', () => {
  it('aggregates every attention kind across all projects', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)

    // Pending permission requests form the Permission Center section. The
    // expired cc_sql request was already published as denied by the adapter,
    // so only cc_data's request remains.
    expect(
      within(drawer).getByRole('region', { name: /cc_data/ })
    ).toHaveTextContent('写入文件')
    expect(
      within(drawer).queryByRole('region', { name: /cc_sql/ })
    ).toBeNull()

    // Cross-project items from 销售数据分析 and 用户研究.
    for (const title of [
      'cc_data 请求写入文件权限',
      'cc_sql 等待输入：确认 6 月数据口径',
      'cc_etl 的 Run 失败：连接超时',
      'cc_etl 的上一次 Run 被中断',
      'cx_review 已完成客户流失复核',
      '飞书任务「Q2 销售目标」存在版本冲突',
      'kimi_docs 不可用：Provider 连接失败',
      '本地任务「月度报表」已完成',
      '销售知识库有未同步的修改',
      '交接包不完整：缺少验证结果',
      '用户研究：后台 Project 已完成全部 Run'
    ]) {
      expect(within(drawer).getByText(title)).toBeVisible()
    }
    for (const kind of [
      '待输入',
      '失败',
      '中断',
      '完成',
      '连接冲突',
      'Provider 不可用'
    ]) {
      expect(within(drawer).getAllByText(kind).length).toBeGreaterThan(0)
    }
  })
})

describe('Global Attention — deep links (#9)', () => {
  it('links a project target to its overview and back across projects', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：用户研究：后台 Project 已完成全部 Run'
      })
    )
    // Drawer closes and the research project overview is shown.
    expect(
      screen.queryByRole('complementary', { name: 'Global Attention' })
    ).toBeNull()
    const overview = await screen.findByRole('region', { name: '项目概览' })
    expect(
      within(overview).getByRole('heading', { name: '用户研究' })
    ).toBeVisible()

    // Returning to the previous project restores its own surface state.
    await switchToProject(user, '销售数据分析')
    const back = await screen.findByRole('region', { name: '项目概览' })
    expect(
      within(back).getByRole('heading', { name: '销售数据分析' })
    ).toBeVisible()
  })

  it('links an agent target to the Agents surface with its unique tab open', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：cc_etl 的 Run 失败：连接超时'
      })
    )
    expect(
      await screen.findByRole('region', { name: 'Agent 目录' })
    ).toBeVisible()
    expect(screen.getByRole('tab', { name: /cc_etl/ })).toBeVisible()
  })

  it('links a run target through the owning agent workspace and retains the runId', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：cc_etl 的上一次 Run 被中断'
      })
    )
    expect(
      await screen.findByRole('region', { name: 'Agent 目录' })
    ).toBeVisible()
    expect(screen.getByRole('tab', { name: /cc_etl/ })).toBeVisible()
    // The Run detail is not delivered yet: the target stays retained on an
    // explicit notice instead of silently degrading to the Agent link.
    expect(
      await screen.findByText(/已保留目标：Run run-etl-001/)
    ).toBeVisible()
  })

  it('opens the target tab even when events arrive after command responses', async () => {
    // A contract-conformant port: a command response may arrive before its
    // view-model-updated event (spec 566–568). The deep link must bind the
    // accepted revision of the first command instead of assuming the event
    // has already landed.
    class DeferredEventPort extends MockScenarioAdapter {
      override subscribe(
        listener: (event: WorkbenchEvent) => void
      ): () => void {
        return super.subscribe((event) => {
          setTimeout(() => listener(event), 0)
        })
      }
    }
    const user = userEvent.setup()
    render(<ProjectShell port={new DeferredEventPort()} />)
    await screen.findByRole('button', { name: '概览' })
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：cc_etl 的 Run 失败：连接超时'
      })
    )
    expect(await screen.findByRole('tab', { name: /cc_etl/ })).toBeVisible()
  })

  it.each([
    {
      title: '本地任务「月度报表」已完成',
      surface: '任务'
    },
    {
      title: '飞书任务「Q2 销售目标」存在版本冲突',
      surface: '任务'
    },
    {
      title: '销售知识库有未同步的修改',
      surface: 'Knowledge'
    }
  ])(
    'navigates to the target surface from attention: $title',
    async ({ title, surface }) => {
      const { user } = await renderShell()
      const { drawer } = await openDrawer(user)
      await user.click(
        within(drawer).getByRole('button', { name: `打开：${title}` })
      )
      expect(
        screen.queryByRole('complementary', { name: 'Global Attention' })
      ).toBeNull()
      // Tasks (#10) and Knowledge (#11) surfaces are now implemented — the
      // deep link lands on real content instead of a placeholder page.
      expect(await screen.findByRole('region', { name: surface })).toBeVisible()
    }
  )

  it('navigates to the Handoffs surface and highlights the specific handoff from attention', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：交接包不完整：缺少验证结果'
      })
    )
    expect(
      screen.queryByRole('complementary', { name: 'Global Attention' })
    ).toBeNull()
    // The Handoffs surface is now implemented (#12) — shows actual handoff
    // data instead of a placeholder page.
    const region = await screen.findByRole('region', { name: '交接' })
    expect(region).toHaveTextContent('不完整')
    expect(region).toHaveTextContent('缺少验证结果')
    // The specific handoff-001 card is highlighted via focus ring (#9 deep link)
    const focusedCard = within(region).getByText('handoff-001')
    expect(focusedCard.closest('li')).toHaveClass('ring-2')
  })
})

describe('Permission Center — decisions (#9)', () => {
  it('offers exactly deny / allow-once / allow-current-run and records the decision', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    const card = within(drawer).getByRole('region', { name: /cc_data/ })
    expect(card).toHaveTextContent('worktree 内 src/data/**')
    expect(card).toHaveTextContent('清洗 Q2 销售流水需要写入中间结果')
    expect(
      within(card).getByRole('button', { name: '拒绝' })
    ).toBeEnabled()
    expect(
      within(card).getByRole('button', { name: '允许当前 Run' })
    ).toBeEnabled()
    // No permanent grant can be created from the request UI.
    expect(
      within(card).queryByRole('button', { name: /永久允许/ })
    ).toBeNull()

    await user.click(within(card).getByRole('button', { name: '允许一次' }))

    // The handled request and its linked attention item leave the pending lists.
    await waitFor(() => {
      expect(
        within(drawer).queryByRole('region', { name: /cc_data/ })
      ).toBeNull()
    })
    expect(
      within(drawer).queryByText('cc_data 请求写入文件权限')
    ).toBeNull()

    // The decision is recorded in Project Activity and the Run resumes.
    await user.click(screen.getByRole('button', { name: '活动' }))
    const activity = await screen.findByRole('region', { name: '活动' })
    expect(activity).toHaveTextContent('权限已决定')
    expect(activity).toHaveTextContent('已允许一次')
    await user.click(screen.getByRole('button', { name: 'Agent' }))
    const directory = await screen.findByRole('region', { name: 'Agent 目录' })
    expect(
      within(directory).getByRole('button', { name: /^cc_data/ })
    ).toHaveTextContent('运行中')
  })

  it('publishes expired requests as denied with audit instead of leaving them pending', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    // perm-002 expired before the scenario loaded: no card, no actions —
    // the adapter already published the default-deny transition.
    expect(
      within(drawer).queryByRole('region', { name: /cc_sql/ })
    ).toBeNull()
    await user.click(screen.getByRole('button', { name: '活动' }))
    const activity = await screen.findByRole('region', { name: '活动' })
    expect(activity).toHaveTextContent('权限已决定')
    expect(activity).toHaveTextContent('已超时，按拒绝处理')
    expect(activity).toHaveTextContent('读取外部 API')
  })

  it('shows the deadline as a port-provided fact without inferring state', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    const card = within(drawer).getByRole('region', { name: /cc_data/ })
    expect(card).toHaveTextContent('默认拒绝截止')
    // While the request is pending its offered actions stay enabled — the
    // adapter owns the timeout transition, not this render.
    expect(within(card).getByRole('button', { name: '拒绝' })).toBeEnabled()
  })

  it('renders only the decisions the authoritative request offers', async () => {
    const scenario = createStandardScenario()
    scenario.permissionRequests[0].decisions = ['deny']
    const { user } = await renderShell(scenario)
    const { drawer } = await openDrawer(user)
    const card = within(drawer).getByRole('region', { name: /cc_data/ })
    expect(within(card).getByRole('button', { name: '拒绝' })).toBeEnabled()
    expect(
      within(card).queryByRole('button', { name: '允许一次' })
    ).toBeNull()
    expect(
      within(card).queryByRole('button', { name: '允许当前 Run' })
    ).toBeNull()
  })

  it('shows non-stale answer rejections next to the request', async () => {
    class RejectingPort extends MockScenarioAdapter {
      override async dispatch(
        command: WorkbenchCommand
      ): Promise<CommandResult> {
        if (command.kind === 'answer-permission') {
          return {
            ok: false,
            commandId: command.commandId,
            reason: 'invalid-target',
            latestRevision: (await this.getSnapshot()).revision,
            message: '权限请求不存在或已处理'
          }
        }
        return super.dispatch(command)
      }
    }
    const user = userEvent.setup()
    render(<ProjectShell port={new RejectingPort()} />)
    await screen.findByRole('button', { name: '概览' })
    const { drawer } = await openDrawer(user)
    const card = within(drawer).getByRole('region', { name: /cc_data/ })
    await user.click(within(card).getByRole('button', { name: '拒绝' }))
    expect(
      await within(card).findByText('权限请求不存在或已处理')
    ).toBeVisible()
  })

  it('routes permanent policy to Settings permissions without creating a grant', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    const card = within(drawer).getByRole('region', { name: /cc_data/ })
    await user.click(
      within(card).getByRole('button', { name: '在 Settings 中管理永久策略' })
    )
    // Drawer closes; Settings opens on the permissions section. No
    // confirmation dialog or permanent grant is created from the request.
    expect(
      screen.queryByRole('complementary', { name: 'Global Attention' })
    ).toBeNull()
    const settings = await screen.findByRole('region', { name: '项目设置' })
    expect(settings).toHaveTextContent('默认权限策略')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      within(screen.getByLabelText('设置目录')).getByRole('button', {
        name: '权限'
      })
    ).toHaveAttribute('aria-current', 'page')
  })

  it.each(['surface', 'project'] as const)(
    'keeps the Settings permissions context when %s navigation is rejected',
    async (navigationKind) => {
      class RejectSettingsExitPort extends MockScenarioAdapter {
        override async dispatch(
          command: WorkbenchCommand
        ): Promise<CommandResult> {
          const rejects =
            command.kind === 'navigate' &&
            ((navigationKind === 'surface' && command.surface === 'tasks') ||
              (navigationKind === 'project' &&
                command.projectId === id('proj-research', 'ProjectId')))
          if (rejects) {
            return {
              ok: false,
              commandId: command.commandId,
              reason: 'unavailable',
              latestRevision: (await this.getSnapshot()).revision,
              message: '目标工作面暂时不可用'
            }
          }
          return super.dispatch(command)
        }
      }

      const user = userEvent.setup()
      render(<ProjectShell port={new RejectSettingsExitPort()} />)
      await screen.findByRole('button', { name: '概览' })
      const { drawer } = await openDrawer(user)
      const card = within(drawer).getByRole('region', { name: /cc_data/ })
      await user.click(
        within(card).getByRole('button', {
          name: '在 Settings 中管理永久策略'
        })
      )
      await screen.findByRole('region', { name: '项目设置' })
      expect(
        within(screen.getByLabelText('设置目录')).getByRole('button', {
          name: '权限'
        })
      ).toHaveAttribute('aria-current', 'page')
      if (navigationKind === 'project') {
        expectCurrentProject('销售数据分析')
      }

      if (navigationKind === 'surface') {
        await user.click(screen.getByRole('button', { name: '任务' }))
      } else {
        await switchToProject(user, '用户研究')
      }

      expect(screen.getByRole('region', { name: '项目设置' })).toBeVisible()
      expect(
        within(screen.getByLabelText('设置目录')).getByRole('button', {
          name: '权限'
        })
      ).toHaveAttribute('aria-current', 'page')
    }
  )

  it('states plainly that the mock is not a real PermissionBroker', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    expect(drawer).toHaveTextContent('未连接真实 PermissionBroker')
  })
})

describe('Global Attention — resolve (#9)', () => {
  it('does not offer generic resolve on permission-requested items', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    // A permission item may only be resolved by an actual decision —
    // never by a fourth, audit-bypassing "mark done" action.
    expect(
      within(drawer).queryByRole('button', {
        name: '标记已处理：cc_data 请求写入文件权限'
      })
    ).toBeNull()
    expect(
      within(drawer).getByRole('button', {
        name: '打开：cc_data 请求写入文件权限'
      })
    ).toBeVisible()
  })

  it('removes a resolved item from pending but keeps it in Project Activity', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '标记已处理：cx_review 已完成客户流失复核'
      })
    )
    // The drawer stays open for batch processing; the item is gone.
    expect(drawer).toBeVisible()
    await waitFor(() => {
      expect(
        within(drawer).queryByText('cx_review 已完成客户流失复核')
      ).toBeNull()
    })
    await user.click(screen.getByRole('button', { name: '活动' }))
    const activity = await screen.findByRole('region', { name: '活动' })
    expect(activity).toHaveTextContent(
      '已处理关注：cx_review 已完成客户流失复核'
    )
    expect(activity).toHaveTextContent('关注已处理')
  })
})

describe('Global Attention — review hardening (#9)', () => {
  it('keeps the frozen-clock smoke scene deterministic', async () => {
    const FROZEN = 1_700_000_000_000
    const adapter = new MockScenarioAdapter(createStandardScenario(FROZEN), {
      now: () => FROZEN
    })
    const user = userEvent.setup()
    render(<ProjectShell port={adapter} />)
    await screen.findByRole('button', { name: '概览' })
    const { drawer } = await openDrawer(user)
    // The frozen clock never reaches perm-001's deadline: the Permission
    // Center scene survives instead of being swept by the wall clock.
    expect(
      within(drawer).getByRole('region', { name: /cc_data/ })
    ).toHaveTextContent('写入文件')
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Agent' }))
    const directory = await screen.findByRole('region', { name: 'Agent 目录' })
    expect(
      within(directory).getByRole('button', { name: /^cc_data/ })
    ).toHaveTextContent('等待权限')
  })

  it('keeps the item and explains when a resolve is rejected', async () => {
    class RejectResolvePort extends MockScenarioAdapter {
      override async dispatch(
        command: WorkbenchCommand
      ): Promise<CommandResult> {
        if (command.kind === 'resolve-attention') {
          return {
            ok: false,
            commandId: command.commandId,
            reason: 'unavailable',
            latestRevision: (await this.getSnapshot()).revision,
            message: '暂时无法处理该关注项，请重试'
          }
        }
        return super.dispatch(command)
      }
    }
    const user = userEvent.setup()
    render(<ProjectShell port={new RejectResolvePort()} />)
    await screen.findByRole('button', { name: '概览' })
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '标记已处理：cx_review 已完成客户流失复核'
      })
    )
    // The rejection is visible and the item stays pending — no silent drop.
    expect(
      await within(drawer).findByText('暂时无法处理该关注项，请重试')
    ).toBeVisible()
    expect(
      within(drawer).getByText('cx_review 已完成客户流失复核')
    ).toBeVisible()
  })

  it('keeps the drawer open and explains when the Settings navigation fails', async () => {
    class RejectSettingsNavPort extends MockScenarioAdapter {
      override async dispatch(
        command: WorkbenchCommand
      ): Promise<CommandResult> {
        if (command.kind === 'navigate' && command.surface === 'settings') {
          return {
            ok: false,
            commandId: command.commandId,
            reason: 'unavailable',
            latestRevision: (await this.getSnapshot()).revision,
            message: '暂时无法打开设置，请重试'
          }
        }
        return super.dispatch(command)
      }
    }
    const user = userEvent.setup()
    render(<ProjectShell port={new RejectSettingsNavPort()} />)
    await screen.findByRole('button', { name: '概览' })
    const { drawer } = await openDrawer(user)
    const card = within(drawer).getByRole('region', { name: /cc_data/ })
    await user.click(
      within(card).getByRole('button', { name: '在 Settings 中管理永久策略' })
    )
    // Navigation failed: the drawer stays open with an explanation instead
    // of closing onto an unchanged surface.
    expect(
      await within(drawer).findByText('暂时无法打开设置，请重试')
    ).toBeVisible()
    expect(drawer).toBeVisible()
    expect(
      screen.queryByRole('region', { name: '项目设置' })
    ).toBeNull()
  })

  it('keeps the deep-link failure notice when explicit navigation is rejected', async () => {
    class RejectDeepLinkAndSurfacePort extends MockScenarioAdapter {
      private rejectedLayout = false

      override async dispatch(
        command: WorkbenchCommand
      ): Promise<CommandResult> {
        if (command.kind === 'change-layout' && !this.rejectedLayout) {
          this.rejectedLayout = true
          return {
            ok: false,
            commandId: command.commandId,
            reason: 'unavailable',
            latestRevision: (await this.getSnapshot()).revision,
            message: '目标 Tab 暂时不可用'
          }
        }
        if (command.kind === 'navigate' && command.surface === 'tasks') {
          return {
            ok: false,
            commandId: command.commandId,
            reason: 'unavailable',
            latestRevision: (await this.getSnapshot()).revision,
            message: '任务工作面暂时不可用'
          }
        }
        return super.dispatch(command)
      }
    }

    const user = userEvent.setup()
    render(<ProjectShell port={new RejectDeepLinkAndSurfacePort()} />)
    await screen.findByRole('button', { name: '概览' })
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：cc_etl 的 Run 失败：连接超时'
      })
    )
    const notice = await screen.findByRole('alert')
    expect(notice).toHaveTextContent('目标 Tab 暂时不可用')

    await user.click(screen.getByRole('button', { name: '任务' }))

    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(
      '目标 Tab 暂时不可用'
    )
  })
})

describe('Global Attention — superseded deep link (#9 review)', () => {
  it('ignores a stale continuation: manual navigation wins, nothing pollutes the chosen page', async () => {
    const commands: WorkbenchCommand[] = []
    class DeferredResultPort extends MockScenarioAdapter {
      private releaseNavigationResult?: () => void

      override dispatch(command: WorkbenchCommand): Promise<CommandResult> {
        commands.push(command)
        const result = super.dispatch(command)
        const isFirstNavigate =
          command.kind === 'navigate' &&
          commands.filter((c) => c.kind === 'navigate').length === 1
        if (isFirstNavigate) {
          // The deep-link navigation publishes its event at once but returns
          // its CommandResult later — a contract-legal order (spec 566–568).
          return new Promise((resolve) => {
            this.releaseNavigationResult = () => void result.then(resolve)
          })
        }
        return result
      }

      releaseNavigation(): void {
        if (!this.releaseNavigationResult) {
          throw new Error('deep-link navigation Result is not pending')
        }
        const release = this.releaseNavigationResult
        this.releaseNavigationResult = undefined
        release()
      }
    }
    const scenario = createStandardScenario()
    scenario.activeGlobalSurface = undefined
    scenario.projects[0].currentSurface = 'overview'
    const port = new DeferredResultPort(scenario)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：cc_etl 的 Run 失败：连接超时'
      })
    )
    // While the deep link's first command result is still in flight, the
    // user navigates manually — this supersedes the whole deep link.
    await user.click(screen.getByRole('button', { name: '任务' }))
    await screen.findByRole('region', { name: '任务' })
    // Let the deferred result land, then observe.
    await new Promise((resolve) => setTimeout(resolve, 60))

    // No stale continuation: no follow-up layout command, no notice, no
    // retained target — the page the user actually chose stays clean.
    expect(commands.some((c) => c.kind === 'change-layout')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/已保留目标/)).toBeNull()
    expect(screen.getByRole('region', { name: '任务' })).toBeVisible()
  })
})

describe('Global Attention — stale and in-surface supersession (#9 review)', () => {
  it('shows a retryable hint when a command stale-rejects instead of swallowing it', async () => {
    // Events lag behind responses: the first resolve succeeds in the port
    // but its snapshot event has not arrived when the user processes the
    // next item, so that command stale-rejects (spec 566–568).
    class DelayedEventPort extends MockScenarioAdapter {
      override subscribe(
        listener: (event: WorkbenchEvent) => void
      ): () => void {
        return super.subscribe((event) => {
          setTimeout(() => listener(event), 100)
        })
      }
    }
    const user = userEvent.setup()
    render(<ProjectShell port={new DelayedEventPort()} />)
    await screen.findByRole('button', { name: '概览' })
    const { drawer } = await openDrawer(user)

    await user.click(
      within(drawer).getByRole('button', {
        name: '标记已处理：cx_review 已完成客户流失复核'
      })
    )
    await user.click(
      within(drawer).getByRole('button', {
        name: '标记已处理：本地任务「月度报表」已完成'
      })
    )

    // The second command stale-rejected: the user must see a recoverable
    // hint (spec 632–633), and the item must still be pending.
    expect(await within(drawer).findByText(/请重试/)).toBeVisible()
    expect(
      within(drawer).getByText('本地任务「月度报表」已完成')
    ).toBeVisible()

    // The upstream refetch makes a retry work.
    await user.click(
      within(drawer).getByRole('button', {
        name: '标记已处理：本地任务「月度报表」已完成'
      })
    )
    await waitFor(() => {
      expect(within(drawer).queryByText(/请重试/)).toBeNull()
    })
    await waitFor(() => {
      expect(
        within(drawer).queryByText('本地任务「月度报表」已完成')
      ).toBeNull()
    })
  })

  it('supersedes an in-flight deep link when the user switches Agent in the directory', async () => {
    const commands: WorkbenchCommand[] = []
    class DeferredResultPort extends MockScenarioAdapter {
      override dispatch(command: WorkbenchCommand): Promise<CommandResult> {
        commands.push(command)
        const result = super.dispatch(command)
        const isFirstNavigate =
          command.kind === 'navigate' &&
          commands.filter((c) => c.kind === 'navigate').length === 1
        if (isFirstNavigate) {
          // Event at once, CommandResult later — a contract-legal order.
          return new Promise((resolve) =>
            setTimeout(() => {
              void result.then(resolve)
            }, 30)
          )
        }
        return result
      }
    }
    const user = userEvent.setup()
    render(<ProjectShell port={new DeferredResultPort()} />)
    await screen.findByRole('button', { name: '概览' })
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：cc_etl 的上一次 Run 被中断'
      })
    )
    // The deep-link navigate event landed (Agents surface); while its result
    // is still in flight the user picks another Agent from the directory.
    const directory = await screen.findByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await screen.findByRole('tab', { name: /cc_sql/ })
    // Let the deferred deep-link result land, then observe.
    await new Promise((resolve) => setTimeout(resolve, 60))

    // The superseded continuation must not write its notice or retained
    // target over the workspace the user actually chose.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()
    expect(screen.getByRole('tab', { name: /cc_sql/ })).toBeVisible()
  })
})

describe('Global Attention — retained target lifetime (#9 review)', () => {
  const sqlAgentId = id('inst-cc-sql', 'AgentInstanceId')
  const etlAgentId = id('inst-cc-etl', 'AgentInstanceId')

  class DeferredTargetSwitchPort extends MockScenarioAdapter {
    private releaseSwitchResult: (() => Promise<void>) | undefined

    override dispatch(command: WorkbenchCommand): Promise<CommandResult> {
      const result = super.dispatch(command)
      if (
        !this.releaseSwitchResult &&
        command.kind === 'change-layout' &&
        command.operation.kind === 'open-tab' &&
        command.operation.agentInstanceId === sqlAgentId
      ) {
        // The authoritative Event is already published by super.dispatch,
        // while this older successful Result remains in flight.
        return new Promise<CommandResult>((resolve) => {
          this.releaseSwitchResult = async () => {
            resolve(await result)
          }
        })
      }
      return result
    }

    hasDeferredSwitch(): boolean {
      return this.releaseSwitchResult !== undefined
    }

    async releaseDeferredSwitch(): Promise<void> {
      const release = this.releaseSwitchResult
      if (!release) throw new Error('target switch result was not deferred')
      this.releaseSwitchResult = undefined
      await release()
    }
  }

  class DeferredEtlDeepLinkPort extends MockScenarioAdapter {
    private shouldDeferEtlTarget = false
    private releaseEtlTargetResult: (() => Promise<void>) | undefined

    deferNextEtlTarget(): void {
      this.shouldDeferEtlTarget = true
    }

    override dispatch(command: WorkbenchCommand): Promise<CommandResult> {
      const result = super.dispatch(command)
      if (
        this.shouldDeferEtlTarget &&
        !this.releaseEtlTargetResult &&
        command.kind === 'change-layout' &&
        command.operation.kind === 'activate-tab' &&
        command.operation.agentInstanceId === etlAgentId
      ) {
        this.shouldDeferEtlTarget = false
        return new Promise<CommandResult>((resolve) => {
          this.releaseEtlTargetResult = async () => {
            resolve(await result)
          }
        })
      }
      return result
    }

    hasDeferredEtlTarget(): boolean {
      return this.releaseEtlTargetResult !== undefined
    }

    async releaseDeferredEtlTarget(): Promise<void> {
      const release = this.releaseEtlTargetResult
      if (!release) throw new Error('cc_etl target result was not deferred')
      this.releaseEtlTargetResult = undefined
      await release()
    }
  }

  async function deepLinkToRun(user: User) {
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：cc_etl 的上一次 Run 被中断'
      })
    )
    return screen.findByText(/已保留目标：Run run-etl-001/)
  }

  it('keeps the retained Run target across Focus and split operations', async () => {
    const { user } = await renderShell()
    expect(await deepLinkToRun(user)).toBeVisible()

    const panels = () => screen.getAllByRole('group', { name: 'Agent 面板' })
    await user.click(
      within(panels()[0]).getByRole('button', { name: 'Focus 此 Panel' })
    )
    expect(screen.getByText(/已保留目标：Run run-etl-001/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '退出 Focus' }))

    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    // Neither operation switched the target: the Run context and the tab
    // both stay.
    expect(screen.getByText(/已保留目标：Run run-etl-001/)).toBeVisible()
    expect(screen.getByRole('tab', { name: /cc_etl/ })).toBeVisible()
  })

  it('clears the retained Run target when the user leaves for a global surface', async () => {
    const { user } = await renderShell()
    expect(await deepLinkToRun(user)).toBeVisible()

    await user.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByRole('region', { name: '全局连接' })
    await switchToProject(user, '销售数据分析')
    await screen.findByRole('region', { name: 'Agent 工作区' })

    expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()
  })

  it('keeps the retained Run target when global navigation is rejected', async () => {
    class RejectGlobalNavigationPort extends MockScenarioAdapter {
      override async dispatch(
        command: WorkbenchCommand
      ): Promise<CommandResult> {
        if (command.kind === 'navigate-global') {
          return {
            ok: false,
            commandId: command.commandId,
            reason: 'unavailable',
            latestRevision: (await this.getSnapshot()).revision,
            message: '全局连接暂时不可用'
          }
        }
        return super.dispatch(command)
      }
    }

    const user = userEvent.setup()
    render(<ProjectShell port={new RejectGlobalNavigationPort()} />)
    await screen.findByRole('button', { name: '概览' })
    expect(await deepLinkToRun(user)).toBeVisible()

    await user.click(screen.getByRole('button', { name: '连接' }))

    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeVisible()
    expect(screen.getByText(/已保留目标：Run run-etl-001/)).toBeVisible()
  })

  it.each(['surface', 'project'] as const)(
    'keeps the retained Run target when explicit %s navigation is rejected',
    async (navigationKind) => {
      class RejectExplicitNavigationPort extends MockScenarioAdapter {
        override async dispatch(
          command: WorkbenchCommand
        ): Promise<CommandResult> {
          const rejects =
            command.kind === 'navigate' &&
            ((navigationKind === 'surface' && command.surface === 'tasks') ||
              (navigationKind === 'project' &&
                command.projectId === id('proj-research', 'ProjectId')))
          if (rejects) {
            return {
              ok: false,
              commandId: command.commandId,
              reason: 'unavailable',
              latestRevision: (await this.getSnapshot()).revision,
              message: '目标工作面暂时不可用'
            }
          }
          return super.dispatch(command)
        }
      }

      const user = userEvent.setup()
      render(<ProjectShell port={new RejectExplicitNavigationPort()} />)
      await screen.findByRole('button', { name: '概览' })
      expect(await deepLinkToRun(user)).toBeVisible()

      if (navigationKind === 'surface') {
        await user.click(screen.getByRole('button', { name: '任务' }))
      } else {
        await switchToProject(user, '用户研究')
      }

      expect(
        screen.getByRole('region', { name: 'Agent 工作区' })
      ).toBeVisible()
      expect(screen.getByText(/已保留目标：Run run-etl-001/)).toBeVisible()
      if (navigationKind === 'project') {
        expectCurrentProject('销售数据分析')
      }
    }
  )

  it('orders a pending rejected navigation ahead of an older target-switch Result', async () => {
    class DeferredRejectedNavigationPort extends DeferredTargetSwitchPort {
      private rejectNavigation: (() => void) | undefined

      override dispatch(command: WorkbenchCommand): Promise<CommandResult> {
        if (
          this.hasDeferredSwitch() &&
          !this.rejectNavigation &&
          command.kind === 'navigate' &&
          command.surface === 'tasks'
        ) {
          return new Promise<CommandResult>((resolve) => {
            this.rejectNavigation = () => {
              void this.getSnapshot().then((snapshot) => {
                resolve({
                  ok: false,
                  commandId: command.commandId,
                  reason: 'unavailable',
                  latestRevision: snapshot.revision,
                  message: '任务工作面暂时不可用'
                })
              })
            }
          })
        }
        return super.dispatch(command)
      }

      hasDeferredNavigation(): boolean {
        return this.rejectNavigation !== undefined
      }

      releaseNavigationRejection(): void {
        const reject = this.rejectNavigation
        if (!reject) throw new Error('navigation rejection was not deferred')
        this.rejectNavigation = undefined
        reject()
      }
    }

    const port = new DeferredRejectedNavigationPort()
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    expect(await deepLinkToRun(user)).toBeVisible()

    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await user.click(screen.getByRole('button', { name: '任务' }))
    expect(port.hasDeferredNavigation()).toBe(true)

    await act(async () => {
      await port.releaseDeferredSwitch()
    })
    // The newer navigation is unresolved, so its eventual success/null or
    // rejection/neutral consequence must decide before the older switch.
    expect(screen.getByText(/已保留目标：Run run-etl-001/)).toBeVisible()

    await act(async () => {
      port.releaseNavigationRejection()
    })
    await waitFor(() => {
      expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()
    })
  })

  it('commits an issued Agent deep link after a structural action cancels its continuation', async () => {
    const port = new DeferredEtlDeepLinkPort()
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    expect(await deepLinkToRun(user)).toBeVisible()

    port.deferNextEtlTarget()
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：cc_etl 的 Run 失败：连接超时'
      })
    )
    await waitFor(() => expect(port.hasDeferredEtlTarget()).toBe(true))

    // Focus only cancels the remaining UI continuation. The Agent deep
    // link's layout Event is already authoritative, so its delivered target
    // semantics (no retained Run detail) must still replace the old Run.
    const panel = screen.getByRole('group', { name: 'Agent 面板' })
    await user.click(
      within(panel).getByRole('button', { name: 'Focus 此 Panel' })
    )
    await act(async () => {
      await port.releaseDeferredEtlTarget()
    })

    expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()
  })

  it('commits a different issued Run target for the same Agent after structural supersession', async () => {
    const scenario = createStandardScenario()
    scenario.attentionItems.push({
      attentionItemId: id('att-etl-run-002', 'AttentionItemId'),
      kind: 'interrupted',
      target: {
        kind: 'run',
        projectId: id('proj-sales', 'ProjectId'),
        agentInstanceId: etlAgentId,
        runId: id('run-etl-002', 'RunId')
      },
      state: 'open',
      title: 'cc_etl 的另一个 Run 被中断'
    })
    const port = new DeferredEtlDeepLinkPort(scenario)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    expect(await deepLinkToRun(user)).toBeVisible()

    port.deferNextEtlTarget()
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：cc_etl 的另一个 Run 被中断'
      })
    )
    await waitFor(() => expect(port.hasDeferredEtlTarget()).toBe(true))

    const panel = screen.getByRole('group', { name: 'Agent 面板' })
    await user.click(
      within(panel).getByRole('button', { name: 'Focus 此 Panel' })
    )
    await act(async () => {
      await port.releaseDeferredEtlTarget()
    })

    expect(screen.getByText(/已保留目标：Run run-etl-002/)).toBeVisible()
    expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()
  })

  it('clears the retained Run target only after a successful target switch', async () => {
    const { user } = await renderShell()
    expect(await deepLinkToRun(user)).toBeVisible()

    // Opening a different Agent abandons the retained Run context.
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await screen.findByRole('tab', { name: /cc_sql/ })
    expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()

    // Re-link, then closing the owning tab clears it too.
    expect(await deepLinkToRun(user)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '关闭标签 cc_etl' }))
    expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()
  })

  it('clears the retained Run target when moving a different Agent makes it active', async () => {
    const { user } = await renderShell()
    await user.click(screen.getByRole('button', { name: 'Agent' }))
    const directory = await screen.findByRole('region', { name: 'Agent 目录' })

    // Put cc_sql in the panel to the right, then return focus to the main
    // panel so the Run deep link opens cc_etl there.
    await user.click(
      within(directory).getByRole('button', {
        name: '在新 Panel 打开 cc_sql'
      })
    )
    await user.click(within(directory).getByRole('button', { name: /^cc_data/ }))
    expect(await deepLinkToRun(user)).toBeVisible()

    // Keyboard move follows cc_sql into the main panel and makes it active.
    // That is a genuine target switch, not a structural layout-only action.
    const sqlTab = screen.getByRole('tab', { name: /cc_sql/ })
    sqlTab.focus()
    await user.keyboard('{Control>}{ArrowLeft}{/Control}')
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /cc_sql/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })
    expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()
  })

  it('clears the retained Run target when closing a Panel activates a migrated Agent', async () => {
    const { user } = await renderShell()
    await user.click(screen.getByRole('button', { name: 'Agent' }))
    const directory = await screen.findByRole('region', { name: 'Agent 目录' })

    // Keep cc_sql alone in a second Panel. The Run target is opened in the
    // original Panel so closing cc_sql's Panel migrates it across.
    await user.click(
      within(directory).getByRole('button', {
        name: '在新 Panel 打开 cc_sql'
      })
    )
    await user.click(within(directory).getByRole('button', { name: /^cc_data/ }))
    expect(await deepLinkToRun(user)).toBeVisible()

    const sqlPanel = screen
      .getAllByRole('group', { name: 'Agent 面板' })
      .find((panel) => within(panel).queryByRole('tab', { name: /cc_sql/ }))
    if (!sqlPanel) throw new Error('cc_sql panel was not rendered')
    await user.click(
      within(sqlPanel).getByRole('button', { name: '关闭 Panel' })
    )
    const dialog = await screen.findByRole('dialog', { name: '关闭 Panel' })
    await user.click(within(dialog).getByRole('button', { name: '迁移并关闭' }))

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /cc_sql/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })
    expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()
  })

  it('clears the retained Run target when a newly created Agent opens in the workspace', async () => {
    const { user } = await renderShell()
    expect(await deepLinkToRun(user)).toBeVisible()

    await user.click(screen.getByRole('button', { name: '新建 Agent' }))
    const dialog = screen.getByRole('dialog', { name: '新建 Agent' })
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Agent 名称' }),
      'cc_new'
    )
    expect(
      within(dialog).getByRole('combobox', { name: '打开方式' })
    ).toHaveValue('current-panel')
    await user.click(within(dialog).getByRole('button', { name: '创建 Agent' }))

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /cc_new/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })
    expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()
  })

  it('ignores an older target-switch result after a newer Run deep link', async () => {
    const port = new DeferredTargetSwitchPort()
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    expect(await deepLinkToRun(user)).toBeVisible()

    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /cc_sql/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })
    expect(port.hasDeferredSwitch()).toBe(true)

    // A newer explicit deep link re-establishes the Run target before the
    // older cc_sql command returns its successful Result.
    expect(await deepLinkToRun(user)).toBeVisible()
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /cc_etl/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })

    await act(async () => {
      await port.releaseDeferredSwitch()
    })
    expect(screen.getByText(/已保留目标：Run run-etl-001/)).toBeVisible()
  })

  it('ignores an older target-switch result after the user returns to the retained Agent', async () => {
    const port = new DeferredTargetSwitchPort()
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    expect(await deepLinkToRun(user)).toBeVisible()

    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /cc_sql/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })
    expect(port.hasDeferredSwitch()).toBe(true)

    // Returning to the retained Agent is a newer target intent even though
    // it does not rewrite the retained Run value.
    await user.click(screen.getByRole('tab', { name: /cc_etl/ }))
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /cc_etl/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })

    await act(async () => {
      await port.releaseDeferredSwitch()
    })
    expect(screen.getByText(/已保留目标：Run run-etl-001/)).toBeVisible()
  })

  it('applies an older successful target switch after a newer return is rejected first', async () => {
    class RejectReturnPort extends DeferredTargetSwitchPort {
      override async dispatch(
        command: WorkbenchCommand
      ): Promise<CommandResult> {
        if (
          this.hasDeferredSwitch() &&
          command.kind === 'change-layout' &&
          command.operation.kind === 'activate-tab' &&
          command.operation.agentInstanceId === etlAgentId
        ) {
          return {
            ok: false,
            commandId: command.commandId,
            reason: 'unavailable',
            latestRevision: (await this.getSnapshot()).revision,
            message: '暂时无法返回 cc_etl'
          }
        }
        return super.dispatch(command)
      }
    }

    const port = new RejectReturnPort()
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    expect(await deepLinkToRun(user)).toBeVisible()

    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await user.click(screen.getByRole('tab', { name: /cc_etl/ }))
    expect(screen.getByRole('tab', { name: /cc_sql/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await act(async () => {
      await port.releaseDeferredSwitch()
    })
    expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()
  })

  it('applies an older successful target switch when its Result precedes a newer rejection', async () => {
    class DeferredRejectReturnPort extends DeferredTargetSwitchPort {
      private releaseReturnRejection: (() => void) | undefined

      override dispatch(command: WorkbenchCommand): Promise<CommandResult> {
        if (
          this.hasDeferredSwitch() &&
          !this.releaseReturnRejection &&
          command.kind === 'change-layout' &&
          command.operation.kind === 'activate-tab' &&
          command.operation.agentInstanceId === etlAgentId
        ) {
          return new Promise<CommandResult>((resolve) => {
            this.releaseReturnRejection = () => {
              void this.getSnapshot().then((snapshot) => {
                resolve({
                  ok: false,
                  commandId: command.commandId,
                  reason: 'unavailable',
                  latestRevision: snapshot.revision,
                  message: '暂时无法返回 cc_etl'
                })
              })
            }
          })
        }
        return super.dispatch(command)
      }

      rejectDeferredReturn(): void {
        const reject = this.releaseReturnRejection
        if (!reject) throw new Error('return rejection was not deferred')
        this.releaseReturnRejection = undefined
        reject()
      }
    }

    const port = new DeferredRejectReturnPort()
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    expect(await deepLinkToRun(user)).toBeVisible()

    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await user.click(screen.getByRole('tab', { name: /cc_etl/ }))

    await act(async () => {
      await port.releaseDeferredSwitch()
    })
    // The newer return is unresolved, so cleanup waits instead of letting
    // the older Result temporarily override that intent.
    expect(screen.getByText(/已保留目标：Run run-etl-001/)).toBeVisible()

    await act(async () => {
      port.rejectDeferredReturn()
    })
    await waitFor(() => {
      expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()
    })
    expect(screen.getByRole('tab', { name: /cc_sql/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('does not let a pending structural Result block a successful target switch', async () => {
    class DeferredFocusPort extends DeferredTargetSwitchPort {
      private releaseFocusResult: (() => Promise<void>) | undefined

      override dispatch(command: WorkbenchCommand): Promise<CommandResult> {
        const result = super.dispatch(command)
        if (
          !this.releaseFocusResult &&
          command.kind === 'change-layout' &&
          command.operation.kind === 'focus-panel'
        ) {
          return new Promise<CommandResult>((resolve) => {
            this.releaseFocusResult = async () => {
              resolve(await result)
            }
          })
        }
        return result
      }

      hasDeferredFocus(): boolean {
        return this.releaseFocusResult !== undefined
      }

      async releaseDeferredFocus(): Promise<void> {
        const release = this.releaseFocusResult
        if (!release) throw new Error('Focus result was not deferred')
        this.releaseFocusResult = undefined
        await release()
      }
    }

    const port = new DeferredFocusPort()
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    expect(await deepLinkToRun(user)).toBeVisible()

    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    const panel = screen.getByRole('group', { name: 'Agent 面板' })
    await user.click(
      within(panel).getByRole('button', { name: 'Focus 此 Panel' })
    )
    expect(port.hasDeferredFocus()).toBe(true)

    // Focus has no Agent target effect. Its unrelated pending Result must
    // not hold the older, now-confirmed cc_sql switch hostage.
    await act(async () => {
      await port.releaseDeferredSwitch()
    })
    expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()

    await act(async () => {
      await port.releaseDeferredFocus()
    })
  })

  it('still applies an older target-switch result after an unrelated Tab closes', async () => {
    const port = new DeferredTargetSwitchPort()
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    expect(await deepLinkToRun(user)).toBeVisible()

    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /cc_sql/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })
    expect(port.hasDeferredSwitch()).toBe(true)

    // Closing an inactive, unrelated Tab does not supersede the target
    // switch that already made cc_sql active.
    await user.click(screen.getByRole('button', { name: '关闭标签 cc_data' }))
    expect(screen.getByRole('tab', { name: /cc_sql/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await act(async () => {
      await port.releaseDeferredSwitch()
    })
    expect(screen.queryByText(/已保留目标：Run run-etl-001/)).toBeNull()
  })

  it('ignores an older target-switch result after closing that Agent returns to the retained Agent', async () => {
    const port = new DeferredTargetSwitchPort()
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    expect(await deepLinkToRun(user)).toBeVisible()

    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /cc_sql/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })
    expect(port.hasDeferredSwitch()).toBe(true)

    // Closing the active cc_sql Tab makes cc_etl active again. That newer
    // target selection must supersede cc_sql's still-pending Result.
    await user.click(screen.getByRole('button', { name: '关闭标签 cc_sql' }))
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /cc_etl/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })

    await act(async () => {
      await port.releaseDeferredSwitch()
    })
    expect(screen.getByText(/已保留目标：Run run-etl-001/)).toBeVisible()
  })

  it('keeps the retained target when the layout command is rejected', async () => {
    class StaleSplitPort extends MockScenarioAdapter {
      private rejected = false
      override async dispatch(
        command: WorkbenchCommand
      ): Promise<CommandResult> {
        if (
          command.kind === 'change-layout' &&
          command.operation.kind === 'split-panel' &&
          !this.rejected
        ) {
          this.rejected = true
          const latest = await this.getSnapshot()
          return {
            ok: false,
            commandId: command.commandId,
            reason: 'stale-revision',
            latestRevision: latest.revision,
            message: 'revision 已过期'
          }
        }
        return super.dispatch(command)
      }
    }
    const user = userEvent.setup()
    render(<ProjectShell port={new StaleSplitPort()} />)
    await screen.findByRole('button', { name: '概览' })
    const { drawer } = await openDrawer(user)
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：cc_etl 的上一次 Run 被中断'
      })
    )
    await screen.findByText(/已保留目标：Run run-etl-001/)

    const panels = () => screen.getAllByRole('group', { name: 'Agent 面板' })
    await user.click(
      within(panels()[0]).getByRole('button', { name: '向右分割' })
    )
    // The command was rejected — the delivered target must not be cleared
    // early.
    expect(screen.getByText(/已保留目标：Run run-etl-001/)).toBeVisible()
  })
})

/**
 * The frozen command-center radar grouping (#68): 需要处理 (permission
 * cards first), 运行中与排队 and 最近完成 agent rows with the 28px Provider
 * avatar and the #65 status dot, plus the header capacity line that mirrors
 * the statusbar facts.
 */
describe('Global Attention — scope and capacity (#99)', () => {
  it('shows the scope-annotated capacity line', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    // #99: capacity line annotates scope (全部项目 / 当前 Project).
    expect(drawer).toHaveTextContent('全部项目')
    expect(drawer).toHaveTextContent('全局运行')
  })

  it('lists permission cards before other attention items inside 需要处理', async () => {
    const { user } = await renderShell()
    const { drawer } = await openDrawer(user)
    const group = within(drawer).getByRole('region', { name: '需要处理' })
    const permissionCard = within(group).getByRole('region', {
      name: /权限请求：cc_data/
    })
    // The card carries the request's full context (#68): scope, reason, the
    // owning Project's applied policy, the deny deadline and every offered
    // decision.
    expect(permissionCard).toHaveTextContent('范围：')
    expect(permissionCard).toHaveTextContent('原因：')
    expect(permissionCard).toHaveTextContent('当前策略：每次询问')
    const attentionItem = within(group).getByText(
      'cc_etl 的 Run 失败：连接超时'
    )
    expect(
      permissionCard.compareDocumentPosition(attentionItem) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
