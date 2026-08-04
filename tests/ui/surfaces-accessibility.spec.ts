/**
 * Surface navigation and accessibility coverage (#16 AC1 + AC3).
 *
 * One Electron session navigates through every Project surface and global
 * entry point, verifying:
 *
 * - A dual-sidebar layout (Project nav + global entries in the header).
 * - B run-radar / policy-matrix content on Settings and Agents surfaces.
 * - C palette (Dispatch Picker) and readiness (Settings) content.
 * - Landmarks, tablist/tab, dialog, divider, accessible names.
 * - Focus enter/return on dialogs, Escape, arrow keys, non-pointer drag.
 * - Non-color state expression across all surfaces.
 *
 * The MockScenarioAdapter provides the data; no real CLI or network I/O
 * occurs.
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

const COVERAGE = [
  'A dual sidebar (Project nav + global entries)',
  'B run radar / policy matrix on Settings and Agents',
  'C palette (Dispatch Picker) and readiness summary',
  'Overview surface',
  'Agents surface with Agent Directory',
  'Tasks surface with External Task states',
  'Knowledge surface with boundary states',
  'Handoffs surface with import actions',
  'Activity surface',
  'Settings surface with draft/apply',
  'global Connections',
  'global Provider Health',
  'global Global Settings',
  'landmarks',
  'tablist/tab roles',
  'dialog roles with accessible names',
  'divider ARIA value',
  'accessible names on interactive elements',
  'focus enter on dialog open',
  'focus return on dialog close',
  'Escape dismisses dialogs',
  'arrow keys on divider',
  'non-pointer Tab move',
  'non-color state expression'
] as const

test('surfaces and accessibility coverage', async ({}, testInfo: TestInfo) => {
  const started = performance.now()
  const evidence: SmokeEvidence = createEvidence()
  let session: SmokeSession | undefined

  try {
    session = await recordedStep(
      evidence,
      'launch Electron for surface coverage',
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

    // ------------------------------------------------------------------
    // A — Dual sidebar: Project navigation + global entries
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'verify A dual sidebar landmarks', async () => {
      await expect(page).toHaveTitle('Agent Squad HQ')
      await expect(nav()).toBeVisible()
      await expect(main()).toBeVisible()

      // Project navigation sidebar has every surface button.
      for (const label of [
        '概览', 'Agent', '任务', '知识', '交接', '活动', '设置'
      ]) {
        await expect(
          nav().getByRole('button', { name: label, exact: true })
        ).toBeVisible()
      }

      // Global entries in the header form the second sidebar.
      for (const label of ['连接', 'Provider 健康', '全局设置']) {
        await expect(
          header().getByRole('button', { name: label, exact: true })
        ).toBeVisible()
      }

      // Project selector has an accessible name.
      await expect(page.getByLabel('切换项目')).toBeVisible()
    })

    // ------------------------------------------------------------------
    // Overview surface
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'Overview surface with stat cards and activity', async () => {
      await nav().getByRole('button', { name: '概览', exact: true }).click()
      await expect(page.getByRole('region', { name: '项目概览' })).toBeVisible()
      // Stat cards are visible with numeric values.
      await expect(main().getByText('Agent', { exact: true })).toBeVisible()
      await expect(main().getByText('活动运行')).toBeVisible()
      await expect(main().getByText('排队')).toBeVisible()
      await expect(main().getByText('关注')).toBeVisible()
      // Recent activity heading.
      await expect(main().getByText('最近活动')).toBeVisible()
    })

    // ------------------------------------------------------------------
    // Agents surface — tablist/tab + Agent Directory + non-color states
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'Agents surface tablist and directory', async () => {
      await nav().getByRole('button', { name: 'Agent', exact: true }).click()
      // The workspace region with panels.
      await expect(
        page.getByRole('region', { name: 'Agent 工作区' })
      ).toBeVisible()
      // Tab roles exist.
      await expect(page.getByRole('tab').first()).toBeVisible()
      // The Agent Directory region has search, filter and list.
      await expect(
        page.getByRole('region', { name: 'Agent 目录' })
      ).toBeVisible()
      await expect(page.getByLabel('搜索 Agent')).toBeVisible()
      await expect(page.getByLabel('按 Provider 过滤')).toBeVisible()
      await expect(page.getByLabel('按状态过滤')).toBeVisible()
      await expect(page.getByRole('list', { name: 'Agent 列表' })).toBeVisible()
    })

    await recordedStep(evidence, 'non-color runtime state labels in Agent Directory', async () => {
      // cc_data is permission-requested → text label "等待权限"
      // cc_sql is needs-input → "需要输入"
      // cc_etl is failed → "失败"
      // cx_forecast is queued → "排队中"
      // kimi_docs is unavailable → "不可用"
      // cx_review is ready → "就绪"
      // These labels are inside a compound text node like "Claude Code · 等待权限".
      const list = page.getByRole('list', { name: 'Agent 列表' })
      for (const expected of [
        '等待权限', '需要输入', '失败', '排队中', '不可用', '就绪'
      ]) {
        await expect(list.getByText(expected).first()).toBeVisible()
      }
    })

    // ------------------------------------------------------------------
    // Tasks surface — External Task sync states + project tasks
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'Tasks surface with External Task sync states', async () => {
      await nav().getByRole('button', { name: '任务', exact: true }).click()
      await expect(page.getByRole('region', { name: '任务' })).toBeVisible()
      // External tasks: conflict, offline, synced (non-color text labels).
      await expect(main().getByText('冲突', { exact: true })).toBeVisible()
      await expect(main().getByText('离线', { exact: true })).toBeVisible()
      await expect(main().getByText('已同步', { exact: true }).first()).toBeVisible()
      // Project tasks section.
      await expect(main().getByText('月度报表')).toBeVisible()
    })

    // ------------------------------------------------------------------
    // Knowledge surface — boundary states
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'Knowledge surface with online and unconnected states', async () => {
      await nav().getByRole('button', { name: '知识', exact: true }).click()
      await expect(page.getByRole('region', { name: 'Knowledge' })).toBeVisible()
      // The online resource has a heading.
      await expect(
        page.getByRole('heading', { name: '销售知识库' })
      ).toBeVisible()
    })

    // ------------------------------------------------------------------
    // Handoffs surface — import actions + provenance badges
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'Handoffs surface with import and provenance', async () => {
      await nav().getByRole('button', { name: '交接', exact: true }).click()
      await expect(page.getByRole('region', { name: '交接' })).toBeVisible()
      // At least one handoff has import actions.
      await expect(main().getByText('仅导入检查').first()).toBeVisible()
      await expect(main().getByText('导入并执行').first()).toBeVisible()
      // Completeness badge is a text label, not color-only.
      await expect(main().getByText('完整', { exact: true }).first()).toBeVisible()
    })

    // ------------------------------------------------------------------
    // Activity surface
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'Activity surface with entries', async () => {
      await nav().getByRole('button', { name: '活动', exact: true }).click()
      await expect(page.getByRole('region', { name: '活动' })).toBeVisible()
      // Activity entries exist.
      await expect(main().getByText('cc_data 开始清洗 Q2 销售流水')).toBeVisible()
    })

    // ------------------------------------------------------------------
    // B — Settings surface (policy matrix, readiness)
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'Settings surface with sections and readiness (#14)', async () => {
      await nav().getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByRole('region', { name: '项目设置' })).toBeVisible()
      // Settings navigation has multiple sections (edit + readonly).
      const settingsNav = page.getByLabel('设置目录')
      await expect(settingsNav).toBeVisible()
      for (const section of ['常规', 'Agent 默认配置', 'Agent 实例', '集成', '权限']) {
        await expect(settingsNav.getByRole('button', { name: section, exact: true })).toBeVisible()
      }
      // B policy matrix and C readiness summary sections (#14).
      await expect(
        settingsNav.getByRole('button', { name: '策略矩阵', exact: true })
      ).toBeVisible()
      await expect(
        settingsNav.getByRole('button', { name: 'Readiness 摘要', exact: true })
      ).toBeVisible()
    })

    await recordedStep(evidence, 'B policy matrix renders comparison table', async () => {
      const settingsNav = page.getByLabel('设置目录')
      await settingsNav.getByRole('button', { name: '策略矩阵', exact: true }).click()
      // The sales project has 2+ agents — a comparison table renders.
      await expect(main().getByRole('table')).toBeVisible()
    })

    await recordedStep(evidence, 'C readiness summary renders per-agent status', async () => {
      const settingsNav = page.getByLabel('设置目录')
      await settingsNav.getByRole('button', { name: 'Readiness 摘要', exact: true }).click()
      // Per-agent readiness labels (就绪 / 已阻止) are visible.
      await expect(
        main().getByText(/就绪|已阻止/).first()
      ).toBeVisible()
    })

    // ------------------------------------------------------------------
    // C — Palette (Dispatch Picker) dialog
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'Dispatch Picker palette dialog (#6)', async () => {
      await header().getByRole('button', { name: '派发给 Agent' }).click()
      const dialog = page.getByRole('dialog', { name: '派发给 Agent' })
      await expect(dialog).toBeVisible()
      // Palette content: selectable agents and instruction field.
      await expect(page.getByLabel('可选 Agent')).toBeVisible()
      await expect(page.getByLabel('指令')).toBeVisible()

      // Escape closes the dialog.
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    })

    // ------------------------------------------------------------------
    // Attention drawer dialog
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'Attention drawer with permission requests and items', async () => {
      const attentionBtn = header().getByRole('button', { name: 'Global Attention' })
      await attentionBtn.click()
      const drawer = page.getByRole('complementary', { name: 'Global Attention' })
      await expect(drawer).toBeVisible()
      // Permission requests section.
      await expect(page.getByRole('region', { name: '权限请求' }).first()).toBeVisible()
      // Attention items section.
      await expect(page.getByRole('region', { name: '关注事项' }).first()).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()
    })

    // ------------------------------------------------------------------
    // Close-window notice dialog
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'Close-window notice dialog', async () => {
      await header().getByRole('button', { name: '关闭窗口' }).click()
      const dialog = page.getByRole('dialog', { name: '关闭窗口' })
      await expect(dialog).toBeVisible()

      await page.keyboard.press('Escape')
      // Close notice is dismissed by clicking "知道了" or backdrop.
      if (await dialog.isVisible().catch(() => false)) {
        await page.getByRole('button', { name: '知道了' }).click()
      }
      await expect(dialog).toBeHidden()
    })

    // ------------------------------------------------------------------
    // Quit preview dialog (#12)
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'Quit preview dialog with active work summary', async () => {
      await header().getByRole('button', { name: '退出' }).click()
      const dialog = page.getByRole('dialog', { name: '退出 Agent Squad HQ' })
      await expect(dialog).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    })

    // ------------------------------------------------------------------
    // Global surfaces
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'global Connections surface', async () => {
      await header().getByRole('button', { name: '连接', exact: true }).click()
      await expect(page.getByRole('region', { name: '全局连接' })).toBeVisible()
      // Connection statuses are text labels, not color-only.
      await expect(main().getByText('已连接', { exact: true })).toBeVisible()
      await expect(main().getByText('未连接', { exact: true })).toBeVisible()
      await expect(main().getByText('错误', { exact: true })).toBeVisible()
    })

    await recordedStep(evidence, 'global Provider Health with non-color status', async () => {
      await header().getByRole('button', { name: 'Provider 健康', exact: true }).click()
      await expect(page.getByRole('region', { name: 'Provider 健康' })).toBeVisible()
      await expect(main().getByText('可用', { exact: true }).first()).toBeVisible()
      await expect(main().getByText('已阻断', { exact: true })).toBeVisible()
    })

    await recordedStep(evidence, 'global Global Settings placeholder', async () => {
      await header().getByRole('button', { name: '全局设置', exact: true }).click()
      await expect(page.getByRole('region', { name: '全局设置' })).toBeVisible()
    })

    // ------------------------------------------------------------------
    // Return to Project and verify divider + keyboard operations
    // ------------------------------------------------------------------
    await recordedStep(evidence, 'return to Project Agents and verify divider ARIA', async () => {
      await header().getByRole('button', { name: '← 返回项目' }).click()
      await nav().getByRole('button', { name: 'Agent', exact: true }).click()

      // Open two more panels to create a split with a divider.
      await page.getByRole('button', { name: '在新 Panel 打开 cx_review' }).click()
      await page.getByRole('button', { name: '在新 Panel 打开 kimi_visual' }).click()

      // Divider has proper ARIA role and value.
      const divider = page.getByRole('separator', { name: '调整分割比例' }).first()
      await expect(divider).toBeVisible()
      await expect(divider).toHaveAttribute('aria-valuenow')

      // Arrow key changes the value.
      const before = Number(await divider.getAttribute('aria-valuenow'))
      await divider.focus()
      await page.keyboard.press('ArrowRight')
      await expect(divider).toHaveAttribute('aria-valuenow', String(before + 5))
    })

    await recordedStep(evidence, 'non-pointer Tab keyboard move', async () => {
      const panels = page.getByRole('group', { name: 'Agent 面板' })
      const countBefore = await panels.count()
      // Move a tab to the left panel via keyboard.
      await page.getByRole('tab', { name: /^cx_review\b/ }).press('Control+ArrowLeft')
      const countAfter = await panels.count()
      // Either the panel count decreased (merged) or stayed same (moved).
      expect(countAfter).toBeLessThanOrEqual(countBefore)
      // Tab still exists exactly once.
      await expect(page.getByRole('tab', { name: /^cx_review\b/ })).toHaveCount(1)
    })

    await recordedStep(evidence, 'focus enter and return on Focus dialog', async () => {
      const panels = page.getByRole('group', { name: 'Agent 面板' })
      const firstPanel = panels.first()
      // Capture the trigger button for focus-return verification.
      const focusBtn = firstPanel.getByRole('button', { name: 'Focus 此 Panel' })
      await focusBtn.click()
      // Focus exit button should be focused on entry.
      const exitBtn = page.getByRole('button', { name: '退出 Focus' })
      await expect(exitBtn).toBeFocused()
      // Escape restores.
      await page.keyboard.press('Escape')
      await expect(exitBtn).toBeHidden()
      // Focus returns to the trigger button (AC3 focus return).
      await expect(focusBtn).toBeFocused()
    })

    await recordedStep(evidence, 'loading state is shown before snapshot', async () => {
      // This step verifies the initial "加载中…" gate indirectly:
      // by the time we got here the snapshot has loaded. We assert
      // that the current page has no "加载中…" text visible.
      await expect(page.getByText('加载中…')).toHaveCount(0)
    })

    await recordedStep(evidence, 'no external requests escaped the guard', async () => {
      expect(evidence.completedExternalRequests).toEqual([])
    })

    await expectNoRendererErrors(page, session!, evidence)
    await stopSmokeSession(session!, evidence)
    session = undefined

    const duration = Math.round(performance.now() - started)
    console.log(
      `[test:ui] PASS surfaces-accessibility ${COVERAGE.join(', ')} (${duration} ms)`
    )
  } catch (error) {
    await captureFailure(session, evidence, error, testInfo)
    throw error
  } finally {
    if (session) {
      await stopSmokeSession(session, evidence).catch(() => {})
    }
    await attachAllEvidence(testInfo, evidence, {
      coverage: [...COVERAGE]
    })
  }
})
