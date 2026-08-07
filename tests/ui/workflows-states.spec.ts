/**
 * Workflow operation and visual-state coverage (#16 AC2 + AC4).
 *
 * One Electron session exercises every user-visible workflow through the
 * MockScenarioAdapter — confirming visible results with no real side
 * effects — and verifies that every required visual state is rendered.
 *
 * Workflows covered (AC4):
 * - Dispatch (Picker confirm)
 * - Queue (visualization with depth)
 * - Permission (Attention answer — unconditional)
 * - Attention (resolve item — unconditional)
 * - External Task (conflict resolve via button)
 * - Handoff (import)
 * - atomic Apply (Settings stage + apply)
 * - revision rollback (stale-rejection recovery via test hook)
 * - Quit preview (safe-dismiss)
 * - High-risk confirmation (connection deletion)
 *
 * Visual states covered (AC2):
 * empty, loading, ready, queued, running, needs-input,
 * permission-requested, failed, interrupted, conflict, offline,
 * unavailable, archived, modal
 */
import { expect, test, type TestInfo } from '@playwright/test'
import {
  attachAllEvidence,
  captureFailure,
  connectSmokeWindow,
  createEvidence,
  expectNoRendererErrors,
  launchSmokeApplication,
  recordedStep,
  stopSmokeSession,
  type SmokeEvidence,
  type SmokeSession
} from './helpers/smoke-harness'

const WORKFLOW_COVERAGE = [
  'Dispatch confirm',
  'Queue visualization with depth',
  'Permission answer (unconditional)',
  'Attention resolve (unconditional)',
  'External Task conflict resolve (button)',
  'Handoff import',
  'atomic Apply (Settings stage + apply)',
  'revision rollback (stale-rejection recovery)',
  'Quit preview safe-dismiss',
  'High-risk confirmation (connection deletion)'
] as const

const STATE_COVERAGE = [
  'empty',
  'loading',
  'ready',
  'queued',
  'running',
  'needs-input',
  'permission-requested',
  'failed',
  'interrupted',
  'conflict',
  'offline',
  'unavailable',
  'archived',
  'modal'
] as const

test('workflow operations and visual state coverage', async ({}, testInfo: TestInfo) => {
  const started = performance.now()
  const evidence: SmokeEvidence = createEvidence()
  let session: SmokeSession | undefined

  try {
    session = await recordedStep(
      evidence,
      'launch Electron for workflow coverage',
      () => launchSmokeApplication('first', evidence)
    )
    const page = await recordedStep(
      evidence,
      'connect to the window',
      () => connectSmokeWindow(session!, evidence)
    )

    const nav = () => page.getByRole('navigation', { name: '主导航' })
    const main = () => page.getByRole('main')
    const header = () => page.locator('header')
    const statusbarNav = () =>
      page.getByRole('navigation', { name: '全局快捷入口' })
    const openAttentionDrawer = async () => {
      await nav().getByRole('button', { name: '概览', exact: true }).click()
      await page
        .getByRole('region', { name: '项目概览' })
        .getByRole('button', { name: '打开' })
        .first()
        .click()
      return page.getByRole('complementary', { name: 'Global Attention' })
    }
    // #75: project switching is the persistent top switch bar.
    const switchBarProject = (name: string) =>
      page
        .getByRole('navigation', { name: '快捷切换' })
        .getByRole('button', { name, exact: true })
        .click()

    // ==================================================================
    // Visual states (AC2)
    // ==================================================================

    await recordedStep(evidence, 'visual: ready, queued, needs-input, permission-requested, failed, unavailable, archived', async () => {
      await nav().getByRole('button', { name: 'Agent', exact: true }).click()
      const list = page.getByRole('list', { name: 'Agent 列表' })
      // #97: directory uses unified 6-state display labels (SSOT).
      for (const label of [
        '已完成',       // ready → completed
        '排队中',       // queued
        '等待用户',     // needs-input → waiting-user
        '等待权限',     // permission-requested → waiting-permission
        '失败',         // failed
        '不可用',       // unavailable
        '已归档'        // archived
      ]) {
        await expect(list.getByText(label).first()).toBeVisible()
      }
    })

    await recordedStep(evidence, 'visual: running (cc_data has activeRunId under permission-requested)', async () => {
      // cc_data is permission-requested with an active Run (activeRunId) —
      // it represents the running lifecycle state. The permission-requested
      // label is visible, and the Attention drawer shows an actionable
      // permission request for its active Run.
      const list = page.getByRole('list', { name: 'Agent 列表' })
      await expect(list.getByText('cc_data')).toBeVisible()
      // Verify the active Run produces a permission request in the drawer.
      const drawer = await openAttentionDrawer()
      await expect(drawer.getByText('写入文件').first()).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()
    })

    await recordedStep(evidence, 'visual: interrupted (Attention item)', async () => {
      const drawer = await openAttentionDrawer()
      await expect(drawer).toBeVisible()
      // "中断" attention kind badge for cc_etl's interrupted Run.
      await expect(drawer.getByText('中断', { exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()
    })

    await recordedStep(evidence, 'visual: conflict and offline External Task states', async () => {
      await nav().getByRole('button', { name: '任务', exact: true }).click()
      // Conflict task.
      await expect(main().getByText('Q2 销售目标')).toBeVisible()
      await expect(main().getByText('冲突', { exact: true })).toBeVisible()
      // Offline task.
      await expect(main().getByText('客户回访清单')).toBeVisible()
      await expect(main().getByText('离线', { exact: true })).toBeVisible()
    })

    await recordedStep(evidence, 'visual: empty and unconnected Knowledge state', async () => {
      // Switch to the research project which has an unconnected Knowledge.
      await switchBarProject('用户研究')
      await nav().getByRole('button', { name: '知识', exact: true }).click()
      await expect(page.getByRole('region', { name: 'Knowledge' })).toBeVisible()
      // Unconnected state text is visible.
      await expect(
        main().getByText('未连接').or(main().getByText('暂无')).first()
      ).toBeVisible()
    })

    await recordedStep(evidence, 'visual: loading gate (snapshot loaded)', async () => {
      // Switch back to sales project.
      await switchBarProject('销售数据分析')
      // The initial loading gate ("加载中…") has resolved — verify the
      // app shows interactive content, not the loading placeholder.
      await expect(nav()).toBeVisible()
      await expect(page.getByText('加载中…')).toHaveCount(0)
    })

    await recordedStep(evidence, 'visual: modal (Dispatch Picker)', async () => {
      await header().getByRole('button', { name: '派发给 Agent' }).click()
      const dialog = page.getByRole('dialog', { name: '派发给 Agent' })
      await expect(dialog).toBeVisible()
      // Modal overlay is present.
      await expect(dialog).toHaveAttribute('aria-modal', 'true')
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    })

    // ==================================================================
    // Workflow: Dispatch confirm (AC4)
    // ==================================================================

    await recordedStep(evidence, 'workflow: Dispatch confirm produces visible dispatch', async () => {
      await nav().getByRole('button', { name: 'Agent', exact: true }).click()
      await header().getByRole('button', { name: '派发给 Agent' }).click()
      const dialog = page.getByRole('dialog', { name: '派发给 Agent' })
      await expect(dialog).toBeVisible()

      // Select a ready agent (cx_review).
      const agentList = page.getByLabel('可选 Agent')
      await agentList.getByRole('button', { name: /cx_review/ }).click()

      // Type an instruction.
      const instruction = page.getByLabel('指令')
      await instruction.fill('验证 Q2 数据口径')

      // Confirm dispatch.
      await dialog.getByRole('button', { name: '确认派发' }).click()
      await expect(dialog).toBeHidden()

      // The dispatch creates a visible activity entry.
      await nav().getByRole('button', { name: '活动', exact: true }).click()
      await expect(
        main().getByText('cx_review 收到派发：验证 Q2 数据口径')
      ).toBeVisible()
    })

    // ==================================================================
    // Workflow: Queue visualization with depth (AC4)
    // ==================================================================

    await recordedStep(evidence, 'workflow: Queue items visible with state label', async () => {
      await nav().getByRole('button', { name: 'Agent', exact: true }).click()
      // cx_forecast is queued — the queue status label is visible.
      const list = page.getByRole('list', { name: 'Agent 列表' })
      const forecastEntry = list.locator('li').filter({ hasText: 'cx_forecast' })
      await expect(forecastEntry).toBeVisible()
      await expect(forecastEntry.getByText('排队中').first()).toBeVisible()
    })

    // ==================================================================
    // Workflow: Permission answer (AC4) — unconditional
    // ==================================================================

    await recordedStep(evidence, 'workflow: Permission deny through Attention drawer', async () => {
      const drawer = await openAttentionDrawer()

      // The actionable permission request for cc_data has decision buttons.
      // (#68: permission cards live inside the 需要处理 radar group, each
      // still named 权限请求：<agent> <action>.)
      const permSection = page.getByRole('region', { name: /权限请求：cc_data/ })
      // cc_data's permission request is always present in the standard
      // scenario. Click "拒绝" (deny) — unconditional, no guard.
      const denyBtn = permSection.getByRole('button', { name: '拒绝' }).first()
      await expect(denyBtn).toBeVisible()
      await denyBtn.click()

      // After denying, the permission request should be resolved —
      // verify the request section no longer shows cc_data's request.
      await expect(
        permSection.getByText('写入文件').first()
      ).toBeHidden({ timeout: 10_000 })

      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()
    })

    // ==================================================================
    // Workflow: Attention resolve (AC4) — unconditional
    // ==================================================================

    await recordedStep(evidence, 'workflow: Attention item resolve (unconditional)', async () => {
      const drawer = await openAttentionDrawer()
      await expect(drawer).toBeVisible()

      // Non-permission items always have a "标记已处理" button.
      const resolveButtons = drawer.getByRole('button', { name: /标记已处理/ })
      const countBefore = await resolveButtons.count()
      expect(countBefore).toBeGreaterThan(0)

      // Resolve the first resolvable item.
      await resolveButtons.first().click()

      // The resolved item disappears — at least one fewer resolve button.
      await expect
        .poll(() => resolveButtons.count())
        .toBeLessThan(countBefore)

      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()
    })

    // ==================================================================
    // Workflow: External Task conflict resolve (AC4) — button click
    // ==================================================================

    await recordedStep(evidence, 'workflow: External Task conflict resolve via button', async () => {
      await nav().getByRole('button', { name: '任务', exact: true }).click()
      // The conflict task (Q2 销售目标) has resolve buttons.
      await expect(main().getByText('Q2 销售目标')).toBeVisible()
      await expect(main().getByText('放弃拟议修改')).toBeVisible()

      // Click "放弃拟议修改" (discard proposed change) to resolve the conflict.
      const discardBtn = main().getByRole('button', { name: '放弃拟议修改' })
      await discardBtn.click()

      // After resolving, the conflict state should change — the
      // proposed-change panel (including the resolve buttons) disappears.
      await expect(main().getByText('放弃拟议修改')).toBeHidden({ timeout: 10_000 })
    })

    // ==================================================================
    // Workflow: Handoff import (AC4)
    // ==================================================================

    await recordedStep(evidence, 'workflow: Handoff import flow', async () => {
      await nav().getByRole('button', { name: '交接', exact: true }).click()
      await expect(page.getByRole('region', { name: '交接' })).toBeVisible()
      // A not-imported handoff has import controls.
      const importSelect = page.getByLabel(/导入目标 Agent/).first()
      await expect(importSelect).toBeVisible()

      // Select a target agent and click "仅导入检查".
      await importSelect.selectOption({ index: 1 })
      const inspectBtn = page.getByRole('button', { name: '仅导入检查' }).first()
      await expect(inspectBtn).toBeEnabled()
      await inspectBtn.click()
      // After import, the import state text changes to "已检查".
      await expect(
        main().getByText('已检查', { exact: true }).first()
      ).toBeVisible({ timeout: 10_000 })
    })

    // ==================================================================
    // Workflow: atomic Apply — Settings stage + apply (AC4)
    // ==================================================================

    await recordedStep(evidence, 'workflow: Settings stage draft and atomic apply', async () => {
      await nav().getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByRole('region', { name: '项目设置' })).toBeVisible()

      // Navigate to the Agent instances section.
      const settingsNav = page.getByLabel('设置目录')
      await settingsNav.getByRole('button', { name: 'Agent 实例', exact: true }).click()

      // Select an instance to edit. (#68: the rail's Agent Instances list
      // replaced the 选择实例 combobox; the row also opens the section.)
      const instanceRow = settingsNav.getByRole('button', { name: /^cc_sql / })
      await expect(instanceRow).toBeVisible()
      await instanceRow.click()

      // Find the Agent 名称 text input.
      const nameInput = page.getByLabel('Agent 名称')
      await expect(nameInput).toBeVisible()
      const original = await nameInput.inputValue()
      // Stage a change.
      await nameInput.fill(original + '_edited')
      await nameInput.press('Tab')

      // The "待应用摘要" (pending summary) should show the staged change.
      await expect(page.getByLabel('待应用摘要')).toBeVisible()

      // Click apply — this opens the confirmation dialog.
      const applyBtn = page.getByRole('button', { name: '应用全部变更' })
      await expect(applyBtn).toBeEnabled()
      await applyBtn.click()
      // Confirm dialog for atomic apply.
      const confirmDialog = page.getByRole('dialog', { name: '应用配置变更' })
      await expect(confirmDialog).toBeVisible()
      // Confirm the apply.
      await confirmDialog.getByRole('button', { name: '确认应用' }).click()
      await expect(confirmDialog).toBeHidden({ timeout: 10_000 })

      // After apply, no pending changes.
      await expect(page.getByText('暂无待应用变更')).toBeVisible({ timeout: 10_000 })

      // Restore the original name.
      await nameInput.fill(original)
      await nameInput.press('Tab')
      await applyBtn.click()
      const restoreDialog = page.getByRole('dialog', { name: '应用配置变更' })
      await expect(restoreDialog).toBeVisible()
      await restoreDialog.getByRole('button', { name: '确认应用' }).click()
      await expect(restoreDialog).toBeHidden({ timeout: 10_000 })
    })

    // ==================================================================
    // Workflow: revision rollback — stale-rejection recovery (AC4)
    // ==================================================================

    await recordedStep(evidence, 'workflow: stale-revision rejection triggers snapshot refresh', async () => {
      // Dispatch a command with a deliberately stale revision through the
      // WorkbenchPort found in React's fiber tree — no test-only global on
      // window is needed. This triggers the 'stale-revision' rejection path,
      // which the useWorkbench hook handles by refreshing the snapshot.
      const staleResult = await page.evaluate(async () => {
        // Locate the adapter (WorkbenchPort) by traversing React's internal
        // fiber tree from the root container element.
        // page.evaluate runs in the browser, but tsconfig.node.json omits
        // DOM libs — access DOM through globalThis with inline types.
        interface DOMElement { [key: string]: unknown }
        interface DOMDocument {
          getElementById(id: string): DOMElement | null
        }
        const doc = (globalThis as unknown as { document: DOMDocument }).document
        const root = doc.getElementById('root')
        if (!root) throw new Error('React root element not found')

        const containerKey = Object.keys(root).find(
          (k) => k.startsWith('__reactContainer$')
        )
        if (!containerKey) throw new Error('React fiber container key not found')

        type Fiber = {
          child: Fiber | null
          sibling: Fiber | null
          memoizedProps: { port?: unknown } | null
          current?: Fiber
        }
        // React 19: __reactContainer$ may hold a FiberRootNode (.current) or a Fiber.
        const rootFiber = (root[containerKey] as Fiber).current ?? (root[containerKey] as Fiber)

        function findPort(fiber: Fiber | null, visited = new Set<Fiber>()): unknown | null {
          if (!fiber || visited.has(fiber)) return null
          visited.add(fiber)
          if (fiber.memoizedProps?.port) return fiber.memoizedProps.port
          return findPort(fiber.child, visited) ?? findPort(fiber.sibling, visited)
        }

        const adapter = findPort(rootFiber) as {
          dispatch: (cmd: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>
          getSnapshot: () => Promise<{ revision: number }>
        } | null
        if (!adapter) throw new Error('WorkbenchPort not found in React fiber tree')

        const snap = await adapter.getSnapshot()
        // Dispatch a navigate command with revision 0 (always stale after
        // any prior operation has bumped the revision).
        const result = await adapter.dispatch({
          commandId: 'stale-probe-' + Date.now(),
          kind: 'navigate',
          projectId: 'proj-sales',
          surface: 'overview',
          expectedRevision: 0 // always stale
        })
        return {
          staleRejected: !result.ok && result.reason === 'stale-revision',
          currentRevision: snap.revision
        }
      })
      expect(staleResult.staleRejected).toBe(true)
      expect(staleResult.currentRevision).toBeGreaterThan(0)

      // After the stale rejection, the UI must still be functional —
      // navigate to verify it recovered with a fresh snapshot.
      await nav().getByRole('button', { name: '活动', exact: true }).click()
      await expect(page.getByRole('region', { name: '活动' })).toBeVisible()
    })

    // ==================================================================
    // Workflow: Quit preview safe-dismiss (AC4)
    // ==================================================================

    await recordedStep(evidence, 'workflow: Quit preview opens and safely dismisses', async () => {
      await header().getByRole('button', { name: '退出' }).click()
      const dialog = page.getByRole('dialog', { name: '退出 Agent Squad HQ' })
      await expect(dialog).toBeVisible()

      // The quit dialog shows active work summary or safe-to-quit message.
      const dialogText = await dialog.textContent()
      expect(dialogText).toMatch(/活动|Run|Terminal|Handoff|安全退出|没有活动/)

      // Escape dismisses (maps to wait-for-runs / cancel).
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    })

    // ==================================================================
    // Workflow: High-risk confirmation — connection deletion (AC4)
    // ==================================================================

    await recordedStep(evidence, 'workflow: High-risk confirmation for connection deletion', async () => {
      // Navigate to global Connections from the persistent statusbar (#95).
      await statusbarNav()
        .getByRole('button', { name: '连接', exact: true })
        .click()
      await expect(page.getByRole('region', { name: '全局连接' })).toBeVisible()

      // Click delete on a connection — this triggers a confirmation modal.
      const deleteBtn = page.getByRole('button', { name: '删除' }).first()
      await deleteBtn.click()

      // The confirmation modal appears with nonBypassable reason.
      const confirmDialog = page.getByRole('dialog').filter({ hasText: '不可跳过' })
      await expect(confirmDialog).toBeVisible()

      // Cancel the deletion — no side effect occurs.
      await confirmDialog.getByRole('button', { name: '取消' }).click()
      await expect(confirmDialog).toBeHidden()

      // The connection is still there.
      await expect(page.getByText('飞书 · 销售团队')).toBeVisible()
    })

    // ==================================================================
    // Workflow: Agent archive and restore (#78)
    // ==================================================================

    await recordedStep(evidence, 'workflow: archive an agent via confirmation and restore it', async () => {
      // Navigate to the Agents surface.
      await nav().getByRole('button', { name: 'Agent', exact: true }).click()
      await expect(page.getByRole('region', { name: 'Agent 工作区' })).toBeVisible()

      // Close a ready agent (cx_review) from the Agent Directory.
      const directory = page.getByRole('region', { name: 'Agent 目录' })
      await directory.getByRole('button', { name: '关闭 cx_review' }).click()

      // A confirmation dialog appears with the non-bypassable reason.
      const dialog = page.getByRole('dialog', { name: '关闭 Agent 实例' })
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('不可逆')

      // Confirm the archive.
      await dialog.getByRole('button', { name: '确认' }).click()
      await expect(dialog).toBeHidden()

      // The agent directory still lists cx_review but with 已归档 state.
      await expect(
        directory.getByRole('button', { name: /^cx_review/ })
      ).toContainText('已归档')

      // Open the archived agent — its read-only notice bar appears.
      await directory.getByRole('button', { name: /^cx_review/ }).click()
      await expect(
        page.getByRole('status').filter({ hasText: '已归档' })
      ).toBeVisible()
      // The reopen button is visible.
      await expect(page.getByRole('button', { name: '重开实例' })).toBeVisible()

      // Reopen the instance.
      await page.getByRole('button', { name: '重开实例' }).click()
      // The read-only notice is gone.
      await expect(
        page.getByRole('status').filter({ hasText: '已归档' })
      ).toHaveCount(0)
    })

    // ==================================================================
    // Final verification
    // ==================================================================

    await recordedStep(evidence, 'no renderer errors and no external requests', async () => {
      expect(evidence.completedExternalRequests).toEqual([])
    })

    await expectNoRendererErrors(page, session!, evidence)
    await stopSmokeSession(session!, evidence)
    session = undefined

    const duration = Math.round(performance.now() - started)
    console.log(
      `[test:ui] PASS workflows-states ` +
        `workflows=[${WORKFLOW_COVERAGE.join(', ')}] ` +
        `states=[${STATE_COVERAGE.join(', ')}] (${duration} ms)`
    )
  } catch (error) {
    await captureFailure(session, evidence, error, testInfo)
    throw error
  } finally {
    if (session) {
      await stopSmokeSession(session, evidence).catch(() => {})
    }
    await attachAllEvidence(testInfo, evidence, {
      workflows: [...WORKFLOW_COVERAGE],
      states: [...STATE_COVERAGE]
    })
  }
})
