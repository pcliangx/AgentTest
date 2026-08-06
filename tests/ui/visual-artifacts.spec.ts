/**
 * Repeatable visual-acceptance capture (#69).
 *
 * One deterministic Electron session (the shared smoke harness, fixed
 * 1280×800 viewport, reduced-motion, contract mock scenario) walks every
 * surface and writes a PNG per surface to `test-results/visual/`, so the
 * manual side-by-side comparison against the frozen prototypes
 * (docs/design) can be re-run at any time with a single command:
 *
 *     npm run capture:visual
 *
 * The spec also runs as part of `npm run test:ui` so the capture flow
 * itself can never rot. Screenshots are artifacts for human comparison —
 * the assertions here only guarantee each surface actually rendered before
 * its capture; nothing pixel-diffs.
 */
import { expect, test, type TestInfo } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
import { UI_SMOKE_SCENARIO } from '../../src/shared/ui-smoke-scenario'

const VISUAL_DIR = resolve('test-results/visual')

test('1280×800 visual artifacts for every surface (#69)', async ({}, testInfo: TestInfo) => {
  const evidence: SmokeEvidence = createEvidence()
  let session: SmokeSession | undefined

  try {
    session = await recordedStep(evidence, 'launch Electron for visual capture', () =>
      launchSmokeApplication('first', evidence)
    )
    const page = await recordedStep(evidence, 'connect to the window', () =>
      connectSmokeWindow(session!, evidence)
    )
    await mkdir(VISUAL_DIR, { recursive: true })

    const nav = () => page.getByRole('navigation', { name: '主导航' })
    const appTier = () => nav().getByRole('group', { name: 'App 级' })
    const statusbarNav = () =>
      page.getByRole('navigation', { name: '全局快捷入口' })

    const capture = async (name: string): Promise<void> => {
      const path = join(VISUAL_DIR, `${name}.png`)
      await page.screenshot({ path })
      await testInfo.attach(`${name}.png`, { path, contentType: 'image/png' })
      evidence.steps.push(`CAPTURE test-results/visual/${name}.png`)
    }

    /** Navigate, prove the surface rendered, let the layout settle, shoot. */
    const captureSurface = async (
      name: string,
      open: () => Promise<void>,
      ready: () => Promise<void>
    ): Promise<void> => {
      await open()
      await ready()
      await page.waitForTimeout(200)
      await capture(name)
    }

    // #76: the app lands on the App-level 首页 — capture it before any
    // navigation.
    await recordedStep(evidence, 'capture 01-home', async () => {
      await expect(page.getByRole('region', { name: '首页' })).toBeVisible()
      await page.waitForTimeout(200)
      await capture('01-home')
    })

    for (const [name, navLabel, regionName] of [
      ['02-overview', '概览', '项目概览'],
      // The Agent Directory lives in the always-on context pane; probe the
      // Agents surface's own region instead.
      ['03-agents', 'Agent', 'Agent 工作区'],
      ['04-tasks', '任务', '任务'],
      ['05-knowledge', '知识', 'Knowledge'],
      ['06-handoffs', '交接', '交接'],
      ['07-activity', '活动', '活动'],
      ['08-settings', '设置', '项目设置']
    ] as const) {
      await recordedStep(evidence, `capture ${name}`, () =>
        captureSurface(
          name,
          () =>
            nav().getByRole('button', { name: navLabel, exact: true }).click(),
          async () => {
            await expect(
              page.getByRole('region', { name: regionName })
            ).toBeVisible()
          }
        )
      )
    }

    for (const [name, appLabel, regionName] of [
      ['09-connections', '连接', '全局连接'],
      ['10-provider-health', 'Provider 健康', 'Provider 健康']
    ] as const) {
      await recordedStep(evidence, `capture ${name}`, () =>
        captureSurface(
          name,
          () =>
            statusbarNav()
              .getByRole('button', { name: appLabel, exact: true })
              .click(),
          async () => {
            await expect(
              page.getByRole('region', { name: regionName })
            ).toBeVisible()
          }
        )
      )
    }

    await recordedStep(evidence, 'capture 11-global-settings', () =>
      captureSurface(
        '11-global-settings',
        () =>
          appTier()
            .getByRole('button', { name: '全局设置', exact: true })
            .click(),
        async () => {
          await expect(
            page.getByRole('region', { name: '全局设置' })
          ).toBeVisible()
        }
      )
    )

    await recordedStep(evidence, 'capture 12-attention-drawer', async () => {
      await nav().getByRole('button', { name: '概览', exact: true }).click()
      await page
        .getByRole('region', { name: '项目概览' })
        .getByRole('button', { name: '打开' })
        .first()
        .click()
      await expect(
        page.getByRole('complementary', { name: 'Global Attention' })
      ).toBeVisible()
      await page.waitForTimeout(200)
      await capture('12-attention-drawer')
      await page.keyboard.press('Escape')
      await expect(
        page.getByRole('complementary', { name: 'Global Attention' })
      ).toBeHidden()
    })

    await recordedStep(evidence, 'capture 13-dispatch-picker', async () => {
      await nav().getByRole('button', { name: '概览', exact: true }).click()
      const overview = page.getByRole('region', { name: '项目概览' })
      await expect(overview).toBeVisible()
      // The ContextPane also offers a 派发给 Agent entry — scope to the
      // Overview region's primary action.
      await overview.getByRole('button', { name: '派发给 Agent' }).click()
      const dialog = page.getByRole('dialog', { name: '派发给 Agent' })
      await expect(dialog).toBeVisible()
      // Fill an @@ mention so target chips and the resource/queue preview
      // render before the capture.
      await dialog
        .getByRole('textbox', { name: '指令' })
        .fill('ask @@cc_data 汇总今日清洗进展')
      await expect(
        dialog.getByRole('region', { name: '派发预览' })
      ).toBeVisible()
      await page.waitForTimeout(200)
      await capture('13-dispatch-picker')
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    })

    await recordedStep(evidence, 'capture 14-project-switch-bar', async () => {
      // #75: the persistent quick-switch bar — one button per Project — is
      // part of every capture above; these artifacts frame the bar itself,
      // on a Project surface and on a global work surface.
      const bar = page.getByRole('navigation', { name: '快捷切换' })
      await expect(bar).toBeVisible()
      await expect(
        bar.getByRole('button', { name: '销售数据分析', exact: true })
      ).toHaveAttribute('aria-current', 'page')
      const projectBox = await bar.boundingBox()
      await bar.screenshot({
        path: join(VISUAL_DIR, '14-project-switch-bar.png')
      })
      await testInfo.attach('14-project-switch-bar.png', {
        path: join(VISUAL_DIR, '14-project-switch-bar.png'),
        contentType: 'image/png'
      })
      evidence.steps.push(
        'CAPTURE test-results/visual/14-project-switch-bar.png'
      )

      // The bar must not jump between project and global views (#75 AC1).
      await statusbarNav()
        .getByRole('button', { name: '连接', exact: true })
        .click()
      await expect(
        page.getByRole('region', { name: '全局连接' })
      ).toBeVisible()
      await expect(bar).toBeVisible()
      // The bar is Projects-only — it marks nothing while a global work
      // surface is active; the current marker lives in the statusbar.
      await expect(bar.locator('[aria-current="page"]')).toHaveCount(0)
      await expect(
        statusbarNav().getByRole('button', { name: '连接', exact: true })
      ).toHaveAttribute('aria-current', 'page')
      const globalBox = await bar.boundingBox()
      expect(globalBox?.x).toBe(projectBox?.x)
      expect(globalBox?.y).toBe(projectBox?.y)
      expect(globalBox?.height).toBe(projectBox?.height)
      await bar.screenshot({
        path: join(VISUAL_DIR, '15-project-switch-bar-global.png')
      })
      await testInfo.attach('15-project-switch-bar-global.png', {
        path: join(VISUAL_DIR, '15-project-switch-bar-global.png'),
        contentType: 'image/png'
      })
      evidence.steps.push(
        'CAPTURE test-results/visual/15-project-switch-bar-global.png'
      )
    })

    await expectNoRendererErrors(page, session, evidence)
  } catch (error) {
    await captureFailure(session, evidence, error, testInfo)
    throw error
  } finally {
    if (session) await stopSmokeSession(session, evidence)
    await attachAllEvidence(testInfo, evidence, UI_SMOKE_SCENARIO)
  }
})
