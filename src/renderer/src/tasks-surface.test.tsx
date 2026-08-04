// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import type { WorkbenchViewModel } from './workbench/contract'

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

async function gotoTasks(user: User) {
  await user.click(screen.getByRole('button', { name: '任务' }))
  return screen.findByRole('region', { name: '任务' })
}

function taskCard(title: string): HTMLElement {
  const card = screen
    .getByText(title)
    .closest('[data-task-card]') as HTMLElement | null
  if (!card) throw new Error(`task card ${title} not found`)
  return card
}

describe('Tasks surface — projections (#10)', () => {
  it('distinguishes local Project Tasks from Feishu External Task projections', async () => {
    const { user } = await renderShell()
    const surface = await gotoTasks(user)

    expect(
      within(surface).getByRole('heading', { name: '本地 Project Task' })
    ).toBeVisible()
    expect(
      within(surface).getByRole('heading', { name: '飞书 External Task 投影' })
    ).toBeVisible()

    const local = taskCard('月度报表')
    expect(local).toHaveTextContent('进行中')

    const external = taskCard('Q2 销售目标')
    expect(external).toHaveTextContent('FS-T-1024')
    expect(external).toHaveTextContent('v3')
    expect(external).toHaveTextContent('冲突')
    expect(external).toHaveTextContent('未完成')

    const offline = taskCard('客户回访清单')
    expect(offline).toHaveTextContent('FS-T-2048')
    expect(offline).toHaveTextContent('离线')
  })

  it('shows per-target dispatches with independent results and review states', async () => {
    const { user } = await renderShell()
    await gotoTasks(user)
    const card = taskCard('Q2 销售目标')
    expect(card).toHaveTextContent('cc_data')
    expect(card).toHaveTextContent('分析 Q2 销售流水缺口')
    expect(card).toHaveTextContent('找到 6 月缺失的 3 个数据源')
    expect(card).toHaveTextContent('待评审')
    expect(card).toHaveTextContent('cx_review')
    expect(card).toHaveTextContent('口径与财务一致，可以归档')
    expect(card).toHaveTextContent('已验收')

    const local = taskCard('月度报表')
    expect(local).toHaveTextContent('kimi_visual')
    expect(local).toHaveTextContent('报表初稿已生成，缺华东区分页')
  })
})

describe('Tasks surface — dispatch (#10)', () => {
  it('dispatches through the planner and produces results only via mock completion', async () => {
    const { user, adapter } = await renderShell()
    await gotoTasks(user)
    const card = taskCard('渠道拓展计划')

    await user.click(
      within(card).getByRole('button', { name: '派发给 Agent' })
    )
    const dialog = await screen.findByRole('dialog', { name: '派发给 Agent' })
    // The picker carries the task context.
    expect(dialog).toHaveTextContent('渠道拓展计划')

    await user.click(
      within(dialog).getByRole('button', { name: /cx_review/ })
    )
    await user.click(
      within(dialog).getByRole('button', { name: /kimi_visual/ })
    )
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      '并行复核 Q2 口径'
    )
    await user.click(
      within(dialog).getByRole('button', { name: '确认派发' })
    )

    // The confirmed planner executes: the first ready target starts, the
    // second queues — and no Execution Result exists yet.
    await waitFor(async () => {
      const snap = await adapter.getSnapshot()
      const task = snap.externalTasks.find(
        (candidate) => candidate.title === '渠道拓展计划'
      )!
      expect(task.dispatchIds.length).toBe(3)
      expect(task.businessStatus).toBe('open')
      const created = snap.dispatches.filter((dispatch) =>
        task.dispatchIds.slice(-2).includes(dispatch.dispatchId)
      )
      expect(created.find((d) => d.agentNameSnapshot === 'cx_review')!.status).toBe(
        'active'
      )
      expect(
        created.find((d) => d.agentNameSnapshot === 'kimi_visual')!.status
      ).toBe('queued')
      for (const dispatch of created) {
        expect(
          snap.executionResults.some(
            (candidate) => candidate.dispatchId === dispatch.dispatchId
          )
        ).toBe(false)
      }
    })
    const updated = taskCard('渠道拓展计划')
    expect(updated).toHaveTextContent('进行中')
    expect(updated).toHaveTextContent('排队中')

    // The explicit mock completion produces the pending-review result.
    await user.click(
      within(updated).getByRole('button', {
        name: /模拟完成：并行复核 Q2 口径/
      })
    )
    await waitFor(() => {
      expect(taskCard('渠道拓展计划')).toHaveTextContent('待评审')
    })
  })

  it('renders dispatch history from the immutable name snapshot', async () => {
    const scenario = createStandardScenario()
    // kimi_visual is renamed after disp-003 was created: history keeps the
    // dispatch-time snapshot, never the renamed identity.
    scenario.agents.find((agent) => agent.name === 'kimi_visual')!.name =
      'renamed_viz'
    const { user } = await renderShell(scenario)
    await gotoTasks(user)
    const card = taskCard('月度报表')
    expect(card).toHaveTextContent('kimi_visual')
    expect(card).not.toHaveTextContent('renamed_viz')
  })
})

describe('Tasks surface — review and acceptance (#10)', () => {
  it('lets the user accept or request revision only after results exist', async () => {
    const { user, adapter } = await renderShell()
    await gotoTasks(user)
    const card = taskCard('Q2 销售目标')

    await user.click(
      within(card).getByRole('button', { name: /验收：找到 6 月缺失/ })
    )
    await waitFor(() => {
      expect(taskCard('Q2 销售目标')).toHaveTextContent('已验收')
    })

    const local = taskCard('月度报表')
    await user.click(
      within(local).getByRole('button', { name: /提出修订：报表初稿/ })
    )
    await waitFor(() => {
      expect(taskCard('月度报表')).toHaveTextContent('已提出修订')
    })

    // The External Task business status is untouched by result reviews.
    const snap = await adapter.getSnapshot()
    expect(
      snap.externalTasks.find((candidate) => candidate.title === 'Q2 销售目标')!
        .businessStatus
    ).toBe('open')
  })

  it('marks business completion only through the explicit confirmation host', async () => {
    const { user } = await renderShell()
    await gotoTasks(user)
    const card = taskCard('渠道拓展计划')
    await user.click(
      within(card).getByRole('button', { name: '标记完成' })
    )

    const dialog = await screen.findByRole('dialog', {
      name: '更新飞书任务状态'
    })
    expect(dialog).toHaveTextContent('渠道拓展计划')
    expect(dialog).toHaveTextContent('不可恢复')
    expect(dialog).toHaveTextContent('无法跳过')

    await user.click(within(dialog).getByRole('button', { name: '确认' }))
    await waitFor(() => {
      const updated = taskCard('渠道拓展计划')
      expect(updated).toHaveTextContent('已完成')
      expect(updated).toHaveTextContent('v3')
    })
  })

  it('refuses the normal status flow on a conflicted task and offers explicit resolution', async () => {
    const scenario = createStandardScenario()
    const conflicted = scenario.externalTasks.find(
      (candidate) => candidate.title === 'Q2 销售目标'
    )!
    conflicted.proposedChange = {
      summary: '标记为「已完成」',
      failureReason: '连接离线，无法写入飞书'
    }
    const { user } = await renderShell(scenario)
    await gotoTasks(user)
    const card = taskCard('Q2 销售目标')

    // The normal flow is blocked: conflict needs explicit resolution.
    await user.click(
      within(card).getByRole('button', { name: '标记完成' })
    )
    expect(
      screen.queryByRole('dialog', { name: '更新飞书任务状态' })
    ).toBeNull()
    expect(await screen.findByText(/任务存在冲突/)).toBeVisible()

    // Overwrite goes through its own confirmation host and settles the
    // conflict atomically.
    await user.click(
      within(card).getByRole('button', { name: '用拟议修改覆盖' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: '覆盖飞书任务冲突'
    })
    expect(dialog).toHaveTextContent('无法跳过')
    await user.click(within(dialog).getByRole('button', { name: '确认' }))
    await waitFor(() => {
      const updated = taskCard('Q2 销售目标')
      expect(updated).toHaveTextContent('已完成')
      expect(updated).toHaveTextContent('已同步')
      expect(updated).not.toHaveTextContent('拟议修改')
    })
  })

  it('discards a conflict proposal and settles sync state atomically', async () => {
    const scenario = createStandardScenario()
    const conflicted = scenario.externalTasks.find(
      (candidate) => candidate.title === 'Q2 销售目标'
    )!
    conflicted.proposedChange = {
      summary: '标记为「已完成」',
      failureReason: '连接离线，无法写入飞书'
    }
    const { user } = await renderShell(scenario)
    await gotoTasks(user)
    const card = taskCard('Q2 销售目标')
    await user.click(
      within(card).getByRole('button', { name: '放弃拟议修改' })
    )
    await waitFor(() => {
      const updated = taskCard('Q2 销售目标')
      expect(updated).toHaveTextContent('已同步')
      expect(updated).toHaveTextContent('未完成')
      expect(updated).not.toHaveTextContent('拟议修改')
    })
  })

  it('keeps the proposed change and failure reason when the external write fails', async () => {
    const { user } = await renderShell()
    await gotoTasks(user)
    const card = taskCard('客户回访清单')
    await user.click(
      within(card).getByRole('button', { name: '标记完成' })
    )

    // No confirmation host for a doomed write: the failure and the proposal
    // stay visible instead.
    expect(
      screen.queryByRole('dialog', { name: '更新飞书任务状态' })
    ).toBeNull()
    await waitFor(() => {
      const updated = taskCard('客户回访清单')
      expect(updated).toHaveTextContent('拟议修改')
      expect(updated).toHaveTextContent('连接离线')
      expect(updated).toHaveTextContent('未完成')
    })
  })
})

describe('Tasks surface — high-risk operations (#10)', () => {
  it('tombstones an External Task through the confirmation host and keeps local audit', async () => {
    const { user } = await renderShell()
    await gotoTasks(user)
    const card = taskCard('门店巡检')
    await user.click(within(card).getByRole('button', { name: '删除' }))

    const dialog = await screen.findByRole('dialog', { name: '删除飞书任务' })
    expect(dialog).toHaveTextContent('门店巡检')
    expect(dialog).toHaveTextContent('无法跳过')
    await user.click(within(dialog).getByRole('button', { name: '确认' }))

    await waitFor(() => {
      const tombstoned = taskCard('门店巡检')
      expect(tombstoned).toHaveTextContent('已删除')
      expect(
        within(tombstoned).queryByRole('button', { name: '删除' })
      ).toBeNull()
    })
  })

  it('keeps the local dispatch history reachable on a tombstoned task', async () => {
    const { user } = await renderShell()
    await gotoTasks(user)
    const card = taskCard('渠道拓展计划')
    await user.click(within(card).getByRole('button', { name: '删除' }))
    const dialog = await screen.findByRole('dialog', { name: '删除飞书任务' })
    await user.click(within(dialog).getByRole('button', { name: '确认' }))

    await waitFor(() => {
      const tombstoned = taskCard('渠道拓展计划')
      expect(tombstoned).toHaveTextContent('已删除')
      // Local Dispatch/Result truth survives the external deletion.
      expect(tombstoned).toHaveTextContent('评估华东渠道缺口')
      expect(tombstoned).toHaveTextContent('华东 3 城渠道覆盖不足')
    })
  })

  it('fails an offline deletion as a kept proposal instead of a fake success', async () => {
    const { user } = await renderShell()
    await gotoTasks(user)
    const card = taskCard('客户回访清单')
    await user.click(within(card).getByRole('button', { name: '删除' }))

    // No confirmation host for a doomed write: the failure and the proposal
    // stay visible instead.
    expect(screen.queryByRole('dialog', { name: '删除飞书任务' })).toBeNull()
    await waitFor(() => {
      const updated = taskCard('客户回访清单')
      expect(updated).toHaveTextContent('拟议修改')
      expect(updated).toHaveTextContent('连接离线')
      expect(updated).not.toHaveTextContent('已删除')
    })
  })

  it('routes member and permission changes through the same confirmation contract', async () => {
    const { user } = await renderShell()
    await gotoTasks(user)
    const card = taskCard('渠道拓展计划')
    await user.click(within(card).getByRole('button', { name: '成员' }))
    const membersDialog = await screen.findByRole('dialog', {
      name: '变更飞书任务成员'
    })
    expect(membersDialog).toHaveTextContent('无法跳过')
    await user.click(
      within(membersDialog).getByRole('button', { name: '取消' })
    )

    await user.click(
      within(taskCard('渠道拓展计划')).getByRole('button', { name: '权限' })
    )
    const permissionsDialog = await screen.findByRole('dialog', {
      name: '变更飞书任务权限'
    })
    expect(permissionsDialog).toHaveTextContent('无法跳过')
    await user.click(
      within(permissionsDialog).getByRole('button', { name: '确认' })
    )
    await waitFor(() => {
      expect(taskCard('渠道拓展计划')).toHaveTextContent('v3')
    })
  })

  it('never performs real Feishu CRUD or network side effects', async () => {
    const apiSpy = vi.fn()
    Object.defineProperty(window, 'api', {
      value: apiSpy,
      writable: true,
      configurable: true
    })
    const { user } = await renderShell()
    await gotoTasks(user)

    // Review, business completion and deletion all exercise the port only.
    await user.click(
      within(taskCard('Q2 销售目标')).getByRole('button', {
        name: /验收：找到 6 月缺失/
      })
    )
    await user.click(
      within(taskCard('渠道拓展计划')).getByRole('button', {
        name: '标记完成'
      })
    )
    await user.click(
      within(
        await screen.findByRole('dialog', { name: '更新飞书任务状态' })
      ).getByRole('button', { name: '确认' })
    )
    await user.click(
      within(taskCard('门店巡检')).getByRole('button', { name: '删除' })
    )
    await user.click(
      within(
        await screen.findByRole('dialog', { name: '删除飞书任务' })
      ).getByRole('button', { name: '确认' })
    )

    expect(apiSpy).not.toHaveBeenCalled()
  })
})

describe('Tasks surface — attention deep links (#10)', () => {
  it('deep-links an external task attention item to its highlighted card', async () => {
    const { user } = await renderShell()
    const trigger = screen.getByRole('button', { name: 'Global Attention' })
    await user.click(trigger)
    const drawer = await screen.findByRole('complementary', {
      name: 'Global Attention'
    })
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：飞书任务「Q2 销售目标」存在版本冲突'
      })
    )
    const surface = await screen.findByRole('region', { name: '任务' })
    expect(surface).toBeVisible()
    const card = taskCard('Q2 销售目标')
    expect(card).toHaveTextContent('深链目标')
  })

  it('deep-links a project task attention item to its highlighted card', async () => {
    const { user } = await renderShell()
    const trigger = screen.getByRole('button', { name: 'Global Attention' })
    await user.click(trigger)
    const drawer = await screen.findByRole('complementary', {
      name: 'Global Attention'
    })
    await user.click(
      within(drawer).getByRole('button', {
        name: '打开：本地任务「月度报表」已完成'
      })
    )
    const surface = await screen.findByRole('region', { name: '任务' })
    expect(surface).toBeVisible()
    expect(taskCard('月度报表')).toHaveTextContent('深链目标')
  })
})

describe('Tasks surface — batch selection hygiene (#10 review)', () => {
  it('prunes the selection after a successful batch delete', async () => {
    const { user } = await renderShell()
    await gotoTasks(user)
    await user.click(screen.getByLabelText('选择 渠道拓展计划'))
    await user.click(screen.getByLabelText('选择 门店巡检'))
    await user.click(
      screen.getByRole('button', { name: '批量删除（2）' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: '批量删除飞书任务'
    })
    await user.click(within(dialog).getByRole('button', { name: '确认' }))

    // Both cards tombstone and the batch control resets instead of keeping
    // ghost selections that can only error.
    await waitFor(() => {
      expect(taskCard('渠道拓展计划')).toHaveTextContent('已删除')
      expect(taskCard('门店巡检')).toHaveTextContent('已删除')
    })
    const batchButton = screen.getByRole('button', {
      name: /批量删除（0）/
    })
    expect(batchButton).toBeDisabled()
    // No stale rejection alert from clicking a ghost batch.
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
