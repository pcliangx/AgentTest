// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
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
import type {
  CommandResult,
  WorkbenchCommand,
  WorkbenchEvent,
  WorkbenchViewModel
} from './workbench/contract'

afterEach(() => cleanup())

type User = ReturnType<typeof userEvent.setup>

async function renderShell(scenario?: WorkbenchViewModel) {
  const adapter = new MockScenarioAdapter(
    scenario ?? createStandardScenario()
  )
  const user = userEvent.setup()
  render(<ProjectShell port={adapter} />)
  await screen.findByRole('button', { name: '概览' })
  return { user, adapter }
}

async function openDrawer(user: User) {
  const trigger = screen.getByRole('button', { name: 'Global Attention' })
  await user.click(trigger)
  const drawer = await screen.findByRole('complementary', {
    name: 'Global Attention'
  })
  return { trigger, drawer }
}

describe('Global Attention — shell entry (#9)', () => {
  it('shows the global pending count on the trigger', async () => {
    await renderShell()
    const trigger = screen.getByRole('button', { name: 'Global Attention' })
    // 9 open items in 销售数据分析 + 2 in 用户研究.
    expect(trigger).toHaveTextContent('11')
  })

  it.each([
    '概览',
    'Agent',
    '任务',
    '知识',
    '交接',
    '活动',
    '设置'
  ] as const)('opens from the %s surface and closes with Escape', async (nav) => {
    const { user } = await renderShell()
    await user.click(screen.getByRole('button', { name: nav }))
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
    await user.selectOptions(screen.getByLabelText('切换项目'), 'proj-sales')
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
      retained: '已保留目标：Project Task ptask-001'
    },
    {
      title: '飞书任务「Q2 销售目标」存在版本冲突',
      retained: '已保留目标：External Task ext-task-001'
    },
    {
      title: '销售知识库有未同步的修改',
      retained: '已保留目标：Knowledge know-001'
    },
    {
      title: '交接包不完整：缺少验证结果',
      retained: '已保留目标：Handoff handoff-001'
    }
  ])(
    'keeps the undelivered target on an explicit placeholder page: $retained',
    async ({ title, retained }) => {
      const { user } = await renderShell()
      const { drawer } = await openDrawer(user)
      await user.click(
        within(drawer).getByRole('button', { name: `打开：${title}` })
      )
      expect(
        screen.queryByRole('complementary', { name: 'Global Attention' })
      ).toBeNull()
      expect(await screen.findByText(/工作面尚未实现/)).toBeVisible()
      expect(screen.getByText(new RegExp(retained))).toBeVisible()
    }
  )
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
})

describe('Global Attention — superseded deep link (#9 review)', () => {
  it('ignores a stale continuation: manual navigation wins, nothing pollutes the chosen page', async () => {
    const commands: WorkbenchCommand[] = []
    class DeferredResultPort extends MockScenarioAdapter {
      override dispatch(command: WorkbenchCommand): Promise<CommandResult> {
        commands.push(command)
        const result = super.dispatch(command)
        const isFirstNavigate =
          command.kind === 'navigate' &&
          commands.filter((c) => c.kind === 'navigate').length === 1
        if (isFirstNavigate) {
          // The deep-link navigation publishes its event at once but returns
          // its CommandResult later — a contract-legal order (spec 566–568).
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
        name: '打开：cc_etl 的 Run 失败：连接超时'
      })
    )
    // While the deep link's first command result is still in flight, the
    // user navigates manually — this supersedes the whole deep link.
    await user.click(screen.getByRole('button', { name: '任务' }))
    await screen.findByText(/任务 工作面尚未实现/)
    // Let the deferred result land, then observe.
    await new Promise((resolve) => setTimeout(resolve, 60))

    // No stale continuation: no follow-up layout command, no notice, no
    // retained target — the page the user actually chose stays clean.
    expect(commands.some((c) => c.kind === 'change-layout')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/已保留目标/)).toBeNull()
    expect(screen.getByText(/任务 工作面尚未实现/)).toBeVisible()
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
