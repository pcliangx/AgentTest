import { expect, test, type TestInfo } from '@playwright/test'
import { UI_SMOKE_SCENARIO } from '../../src/shared/ui-smoke-scenario'
import {
  attachAllEvidence,
  captureFailure,
  collectBlockedNetworkEvidence,
  connectSmokeWindow,
  createEvidence,
  expectNoRendererErrors,
  initialSignature,
  launchSmokeApplication,
  NETWORK_PROBE_URLS,
  probeNetworkGuard,
  recordedStep,
  stopSmokeSession,
  type SmokeEvidence,
  type SmokeSession
} from './helpers/smoke-harness'

const SCENARIO = {
  ...UI_SMOKE_SCENARIO,
  rendererSource: 'production-file',
  coverage: [
    'Project Shell',
    'Project navigation',
    'pre-renderer network guard',
    'renderer error gate',
    'three Panel baseline',
    'fourth Panel scroll and operation',
    'Tab keyboard move',
    'divider keyboard resize',
    'Focus restore',
    'deterministic relaunch'
  ]
} as const

test('1280×800 deterministic Electron smoke covers the core workspace', async ({}, testInfo: TestInfo) => {
  const started = performance.now()
  const evidence: SmokeEvidence = createEvidence()
  let activeSession: SmokeSession | undefined
  let firstSignature: unknown

  try {
    activeSession = await recordedStep(
      evidence,
      'launch the first isolated Electron process',
      () => launchSmokeApplication('first', evidence)
    )
    const page = await recordedStep(
      evidence,
      'connect to the first Electron window',
      () => connectSmokeWindow(activeSession!, evidence)
    )

    firstSignature = await recordedStep(evidence, 'launch isolated deterministic shell', async () => {
      await expect(page).toHaveTitle('Agent Squad HQ')
      await expect(page.getByText('Agent Squad HQ', { exact: true })).toBeVisible()
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
      await expect(page.getByLabel('切换项目')).toHaveValue('proj-sales')
      await expect(page.getByRole('region', { name: '项目概览' })).toBeVisible()
      expect(await activeSession!.app.evaluate(({ app }) => app.getPath('userData'))).toBe(
        activeSession!.userDataPath
      )
      expect(await activeSession!.app.evaluate(({ app }) => app.getPath('sessionData'))).toBe(
        activeSession!.userDataPath
      )
      await expect
        .poll(() =>
          evidence.console.some((line) =>
            line.includes('UI smoke mode: real main services are disabled')
          )
        )
        .toBe(true)
      await expect
        .poll(() =>
          evidence.console.some((line) =>
            line.includes(
              `renderer scenario: ${SCENARIO.id}@${SCENARIO.clock}`
            )
          )
        )
        .toBe(true)
      const signature = await initialSignature(page)
      expect(signature).toMatchObject({
        protocol: 'file:',
        scenario: SCENARIO.id,
        viewport: SCENARIO.viewport
      })
      return signature
    })

    await recordedStep(
      evidence,
      'block HTTP and WebSocket in Electron before renderer traffic',
      async () => {
        expect(await probeNetworkGuard(page)).toEqual({
          http: 'blocked',
          websocket: 'blocked'
        })
        await expect
          .poll(async () => {
            const records = await collectBlockedNetworkEvidence(
              activeSession!,
              evidence
            )
            return records.map((record) => record.url)
          })
          .toEqual(
            expect.arrayContaining([
              NETWORK_PROBE_URLS.http,
              NETWORK_PROBE_URLS.websocket
            ])
          )
      }
    )

    await recordedStep(evidence, 'navigate through the Project Shell', async () => {
      const navigation = page.getByRole('navigation', { name: '主导航' })
      await navigation.getByRole('button', { name: 'Agent', exact: true }).click()
      await expect(page.getByRole('region', { name: 'Agent 工作区' })).toBeVisible()
      await navigation.getByRole('button', { name: '概览', exact: true }).click()
      await expect(page.getByRole('region', { name: '项目概览' })).toBeVisible()
      await navigation.getByRole('button', { name: 'Agent', exact: true }).click()
    })

    const panels = page.getByRole('group', { name: 'Agent 面板' })
    await recordedStep(evidence, 'open the three Panel baseline', async () => {
      await page.getByRole('button', { name: '在新 Panel 打开 cx_review' }).click()
      await page.getByRole('button', { name: '在新 Panel 打开 kimi_visual' }).click()
      await expect(panels).toHaveCount(3)
      await expect(page.getByRole('tab', { name: /^cc_data\b/ })).toHaveCount(1)
      await expect(page.getByRole('tab', { name: /^cx_review\b/ })).toHaveCount(1)
      await expect(page.getByRole('tab', { name: /^kimi_visual\b/ })).toHaveCount(1)
    })

    await recordedStep(evidence, 'move a Tab with the public keyboard path', async () => {
      await page.getByRole('tab', { name: /^cx_review\b/ }).press('Control+ArrowLeft')
      await expect(panels).toHaveCount(2)
      const destination = panels
        .filter({ has: page.getByRole('tab', { name: /^cc_data\b/ }) })
        .filter({ has: page.getByRole('tab', { name: /^cx_review\b/ }) })
      await expect(destination).toHaveCount(1)
      await expect(page.getByRole('tab', { name: /^cx_review\b/ })).toHaveCount(1)
    })

    await recordedStep(evidence, 'allow a fourth Panel with visible overflow guidance', async () => {
      await page.getByRole('button', { name: '在新 Panel 打开 cc_sql' }).click()
      await page.getByRole('button', { name: '在新 Panel 打开 cc_etl' }).click()
      await expect(panels).toHaveCount(4)
      await expect(page.getByRole('note')).toContainText('当前打开 4 个 Panel')
      await expect(page.getByRole('note')).toContainText('空间不足时可滚动查看')

      const panelGeometry = await panels.evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect()
          return { width: rect.width, height: rect.height }
        })
      )
      for (const geometry of panelGeometry) {
        expect(geometry.width).toBeGreaterThanOrEqual(
          SCENARIO.minimumPanelSize.width
        )
        expect(geometry.height).toBeGreaterThanOrEqual(
          SCENARIO.minimumPanelSize.height
        )
      }

      // Overflow surfaces at the innermost split container whose children
      // hit the minimum Panel size (UX-v0.2 §7.2(8)); the workspace main
      // and the document itself stay fixed.
      const fourthPanel = panels.filter({
        has: page.getByRole('tab', { name: /^cc_etl\b/ })
      })
      await expect(fourthPanel).toHaveCount(1)
      const overflow = await fourthPanel.evaluate((element) => {
        let ancestor = element.parentElement
        while (ancestor) {
          if (
            ancestor.classList.contains('overflow-auto') &&
            ancestor.scrollWidth > ancestor.clientWidth
          ) {
            const before = ancestor.scrollLeft
            ancestor.scrollTo({ left: ancestor.scrollWidth })
            return {
              clientWidth: ancestor.clientWidth,
              scrollWidth: ancestor.scrollWidth,
              before,
              after: ancestor.scrollLeft
            }
          }
          ancestor = ancestor.parentElement
        }
        return null
      })
      if (!overflow) {
        throw new Error('no scrollable overflow container at four panels')
      }
      expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth)
      expect(overflow.after).toBeGreaterThan(overflow.before)
      expect(
        await page.evaluate<{ clientWidth: number; scrollWidth: number }>(
          '({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth })'
        )
      ).toEqual({
        clientWidth: SCENARIO.viewport.width,
        scrollWidth: SCENARIO.viewport.width
      })

      await page.getByRole('button', { name: '关闭密度提示' }).click()
      await expect(page.getByRole('note')).toBeHidden()

      await fourthPanel.scrollIntoViewIfNeeded()
      await expect(fourthPanel).toBeInViewport({ ratio: 0.75 })

      await fourthPanel.getByRole('button', { name: 'Focus 此 Panel' }).click()
      await expect(panels).toHaveCount(1)
      await expect(page.getByRole('tab', { name: /^cc_etl\b/ })).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(panels).toHaveCount(4)
    })

    await recordedStep(evidence, 'resize a divider through its ARIA value', async () => {
      const divider = page.getByRole('separator', { name: '调整分割比例' }).first()
      const before = Number(await divider.getAttribute('aria-valuenow'))
      await divider.press('ArrowRight')
      await expect(divider).toHaveAttribute('aria-valuenow', String(before + 5))
    })

    await recordedStep(evidence, 'restore all Panels after temporary Focus', async () => {
      const ccDataPanel = panels.filter({
        has: page.getByRole('tab', { name: /^cc_data\b/ })
      })
      await ccDataPanel.getByRole('button', { name: 'Focus 此 Panel' }).click()
      await expect(page.getByRole('button', { name: '退出 Focus' })).toBeFocused()
      await expect(panels).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(panels).toHaveCount(4)
      await expect(page.getByRole('separator', { name: '调整分割比例' })).toHaveCount(3)
      await expect(
        panels
          .filter({ has: page.getByRole('tab', { name: /^cc_data\b/ }) })
          .filter({ has: page.getByRole('tab', { name: /^cx_review\b/ }) })
      ).toHaveCount(1)
    })

    await expectNoRendererErrors(page, activeSession, evidence)
    expect(evidence.completedExternalRequests).toEqual([])
    await stopSmokeSession(activeSession, evidence)
    activeSession = undefined

    activeSession = await recordedStep(
      evidence,
      'launch the second isolated Electron process',
      () => launchSmokeApplication('second', evidence)
    )
    await recordedStep(evidence, 'relaunch from a fresh directory without state drift', async () => {
      const secondPage = await connectSmokeWindow(activeSession!, evidence)
      await expect(secondPage.getByRole('region', { name: '项目概览' })).toBeVisible()
      expect(await initialSignature(secondPage)).toEqual(firstSignature)
      await expectNoRendererErrors(secondPage, activeSession!, evidence)
      expect(evidence.completedExternalRequests).toEqual([])
    })
    await stopSmokeSession(activeSession, evidence)
    activeSession = undefined

    const duration = Math.round(performance.now() - started)
    console.log(
      `[test:ui] PASS ${SCENARIO.viewport.width}×${SCENARIO.viewport.height} ` +
        `${SCENARIO.coverage.join(', ')} (${duration} ms)`
    )
  } catch (error) {
    await captureFailure(activeSession, evidence, error, testInfo)
    throw error
  } finally {
    if (activeSession) {
      await stopSmokeSession(activeSession, evidence).catch(() => {})
    }
    await attachAllEvidence(testInfo, evidence, SCENARIO)
  }
})
