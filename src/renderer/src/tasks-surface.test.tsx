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
  it('dispatches one External Task to multiple Agents through the unified picker', async () => {
    const { user, adapter } = await renderShell()
    await gotoTasks(user)
    const card = taskCard('Q2 销售目标')

    await user.click(
      within(card).getByRole('button', { name: '派发给 Agent' })
    )
    const dialog = await screen.findByRole('dialog', { name: '派发给 Agent' })
    // The picker carries the task context.
    expect(dialog).toHaveTextContent('Q2 销售目标')

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

    // Each target forms an independent Dispatch/Result, and the External
    // Task is NOT auto-completed.
    await waitFor(async () => {
      const snap = await adapter.getSnapshot()
      const task = snap.externalTasks.find(
        (candidate) => candidate.title === 'Q2 销售目标'
      )!
      expect(task.dispatchIds.length).toBe(4)
      expect(task.businessStatus).toBe('open')
      const pending = snap.executionResults.filter(
        (result) =>
          result.taskRef.kind === 'external-task' &&
          result.taskRef.externalTaskId === task.externalTaskId &&
          result.reviewState === 'pending-review'
      )
      expect(pending.length).toBeGreaterThanOrEqual(3)
    })
    // The new results render in the card.
    const updated = taskCard('Q2 销售目标')
    expect(updated).toHaveTextContent('并行复核 Q2 口径')
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
    const card = taskCard('Q2 销售目标')
    await user.click(
      within(card).getByRole('button', { name: '标记完成' })
    )

    const dialog = await screen.findByRole('dialog', {
      name: '更新飞书任务状态'
    })
    expect(dialog).toHaveTextContent('Q2 销售目标')
    expect(dialog).toHaveTextContent('不可恢复')
    expect(dialog).toHaveTextContent('无法跳过')

    await user.click(within(dialog).getByRole('button', { name: '确认' }))
    await waitFor(() => {
      const updated = taskCard('Q2 销售目标')
      expect(updated).toHaveTextContent('已完成')
      expect(updated).toHaveTextContent('v4')
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
  it('deletes an External Task only through the confirmation host', async () => {
    const { user } = await renderShell()
    await gotoTasks(user)
    const card = taskCard('客户回访清单')
    await user.click(within(card).getByRole('button', { name: '删除' }))

    const dialog = await screen.findByRole('dialog', { name: '删除飞书任务' })
    expect(dialog).toHaveTextContent('客户回访清单')
    expect(dialog).toHaveTextContent('无法跳过')
    await user.click(within(dialog).getByRole('button', { name: '确认' }))

    await waitFor(() => {
      expect(screen.queryByText('客户回访清单')).toBeNull()
    })
  })

  it('routes member and permission changes through the same confirmation contract', async () => {
    const { user } = await renderShell()
    await gotoTasks(user)
    const card = taskCard('Q2 销售目标')
    await user.click(within(card).getByRole('button', { name: '成员' }))
    const membersDialog = await screen.findByRole('dialog', {
      name: '变更飞书任务成员'
    })
    expect(membersDialog).toHaveTextContent('无法跳过')
    await user.click(
      within(membersDialog).getByRole('button', { name: '取消' })
    )

    await user.click(
      within(taskCard('Q2 销售目标')).getByRole('button', { name: '权限' })
    )
    const permissionsDialog = await screen.findByRole('dialog', {
      name: '变更飞书任务权限'
    })
    expect(permissionsDialog).toHaveTextContent('无法跳过')
    await user.click(
      within(permissionsDialog).getByRole('button', { name: '确认' })
    )
    await waitFor(() => {
      expect(taskCard('Q2 销售目标')).toHaveTextContent('v4')
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
      within(taskCard('Q2 销售目标')).getByRole('button', { name: '标记完成' })
    )
    await user.click(
      within(
        await screen.findByRole('dialog', { name: '更新飞书任务状态' })
      ).getByRole('button', { name: '确认' })
    )
    await user.click(
      within(taskCard('客户回访清单')).getByRole('button', { name: '删除' })
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
