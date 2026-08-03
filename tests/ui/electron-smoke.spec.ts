import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { UI_SMOKE_SCENARIO } from '../../src/shared/ui-smoke-scenario'

const require = createRequire(resolve(process.cwd(), 'package.json'))
const electronExecutablePath = require('electron') as string

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

interface SmokeEvidence {
  readonly blockedNetworkRequests: string[]
  readonly completedExternalRequests: string[]
  readonly console: string[]
  readonly rendererErrors: string[]
  readonly steps: string[]
}

type LaunchLabel = 'first' | 'second'

interface SmokeSession {
  readonly app: ElectronApplication
  page?: Page
  readonly pid: number
  readonly launchLabel: LaunchLabel
  readonly userDataPath: string
}

function recordRendererError(
  session: SmokeSession,
  evidence: SmokeEvidence,
  message: string
): void {
  const entry = `[${session.launchLabel}:renderer:error] ${message}`
  if (!evidence.rendererErrors.includes(entry)) {
    evidence.rendererErrors.push(entry)
    evidence.console.push(entry)
  }
}

function sanitizedEnvironment(userDataPath: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !/(?:TOKEN|SECRET|PASSWORD|API_KEY|COOKIE|CLAUDE|CODEX|KIMI|FEISHU|LARK|OPENAI|AGENTTEST|AGENT_SQUAD_HQ_)/i.test(
        key
      )
    ) {
      env[key] = value
    }
  }
  return {
    ...env,
    AGENT_SQUAD_HQ_UI_TEST: '1',
    AGENT_SQUAD_HQ_UI_TEST_USER_DATA_DIR: userDataPath,
    // A stale dev-shell value must never override the built renderer in smoke mode.
    ELECTRON_RENDERER_URL:
      'data:text/html,<title>stale dev renderer must be ignored</title>'
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function launchSmokeApplication(
  launchLabel: LaunchLabel,
  evidence: SmokeEvidence
): Promise<SmokeSession> {
  const userDataPath = await mkdtemp(
    join(tmpdir(), `agent-squad-hq-ui-smoke-${launchLabel}-`)
  )
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: [resolve('out/main/index.js')],
      cwd: process.cwd(),
      env: sanitizedEnvironment(userDataPath),
      executablePath: electronExecutablePath
    })
    const child = app.process()
    child.stdout?.on('data', (chunk: Buffer | string) => {
      evidence.console.push(
        `[${launchLabel}:main:stdout] ${String(chunk).trimEnd()}`
      )
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      evidence.console.push(
        `[${launchLabel}:main:stderr] ${String(chunk).trimEnd()}`
      )
    })

    const context = app.context()
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })

    return {
      app,
      pid: child.pid ?? -1,
      launchLabel,
      userDataPath
    }
  } catch (error) {
    await app?.close().catch(() => {})
    await rm(userDataPath, { recursive: true, force: true })
    throw error
  }
}

async function connectSmokeWindow(
  session: SmokeSession,
  evidence: SmokeEvidence
): Promise<Page> {
  const page = await session.app.firstWindow()
  session.page = page
  page.on('pageerror', (error) => {
    recordRendererError(session, evidence, error.message)
  })
  for (const error of await page.pageErrors()) {
    recordRendererError(session, evidence, error.message)
  }
  page.on('requestfinished', (request) => {
    if (/^(?:https?|wss?):\/\//i.test(request.url())) {
      evidence.completedExternalRequests.push(request.url())
    }
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  return page
}

interface BlockedNetworkRequest {
  readonly url: string
  readonly resourceType: string
}

async function readBlockedNetworkRequests(
  session: SmokeSession
): Promise<BlockedNetworkRequest[]> {
  try {
    const contents = await readFile(
      join(session.userDataPath, SCENARIO.networkEvidenceFile),
      'utf8'
    )
    return contents
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BlockedNetworkRequest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function collectBlockedNetworkEvidence(
  session: SmokeSession,
  evidence: SmokeEvidence
): Promise<BlockedNetworkRequest[]> {
  const records = await readBlockedNetworkRequests(session)
  for (const record of records) {
    const entry = `[${session.launchLabel}:${record.resourceType}] ${record.url}`
    if (!evidence.blockedNetworkRequests.includes(entry)) {
      evidence.blockedNetworkRequests.push(entry)
    }
  }
  return records
}

async function expectNoRendererErrors(
  page: Page,
  session: SmokeSession,
  evidence: SmokeEvidence
): Promise<void> {
  const errors = (await page.pageErrors()).map((error) => error.message)
  for (const message of errors) {
    recordRendererError(session, evidence, message)
  }
  expect(
    evidence.rendererErrors.filter((entry) =>
      entry.startsWith(`[${session.launchLabel}:renderer:error]`)
    ),
    `${session.launchLabel} renderer must have no uncaught errors`
  ).toEqual([])
}

async function stopSmokeSession(
  session: SmokeSession,
  evidence: SmokeEvidence
): Promise<void> {
  try {
    await collectBlockedNetworkEvidence(session, evidence)
    await session.app.context().tracing.stop().catch(() => {})
    await session.app.close()
    if (session.pid > 0) {
      await expect
        .poll(() => isProcessAlive(session.pid), { timeout: 5_000 })
        .toBe(false)
    }
  } finally {
    await rm(session.userDataPath, { recursive: true, force: true })
  }
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;'
      })[character] ?? character
  )
}

function unavailableWindowVisual(
  evidence: SmokeEvidence,
  error: unknown
): Buffer {
  const message = error instanceof Error ? error.message : String(error)
  const lastStep = evidence.steps.at(-1) ?? 'Electron launch did not start a step'
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
      <rect width="1280" height="800" fill="#0a0a0a"/>
      <text x="64" y="100" fill="#f5f5f5" font-family="system-ui, sans-serif" font-size="32">
        Electron window unavailable
      </text>
      <text x="64" y="160" fill="#fca5a5" font-family="monospace" font-size="18">
        ${escapeXml(message.slice(0, 110))}
      </text>
      <text x="64" y="205" fill="#a3a3a3" font-family="monospace" font-size="16">
        ${escapeXml(lastStep.slice(0, 125))}
      </text>
    </svg>
  `)
}

async function captureFailure(
  session: SmokeSession | undefined,
  evidence: SmokeEvidence,
  error: unknown,
  testInfo: TestInfo
): Promise<void> {
  const page = session?.page ?? session?.app.windows()[0]
  let screenshotAttached = false
  if (page && !page.isClosed()) {
    const screenshotPath = testInfo.outputPath('failure.png')
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('failure-screenshot', {
        path: screenshotPath,
        contentType: 'image/png'
      })
      screenshotAttached = true
    } catch {
      // The diagnostic visual below is the fail-safe for a lost renderer.
    }
  }
  if (!screenshotAttached) {
    await testInfo.attach('failure-screenshot-unavailable', {
      body: unavailableWindowVisual(evidence, error),
      contentType: 'image/svg+xml'
    })
  }

  if (session) {
    const tracePath = testInfo.outputPath('trace.zip')
    try {
      await session.app.context().tracing.stop({ path: tracePath })
      await testInfo.attach('failure-trace', {
        path: tracePath,
        contentType: 'application/zip'
      })
    } catch {
      await testInfo.attach('failure-trace-unavailable', {
        body: Buffer.from('Electron exited before a Playwright trace was available.'),
        contentType: 'text/plain'
      })
    }
  }
}

async function recordedStep<T>(
  evidence: SmokeEvidence,
  name: string,
  action: () => Promise<T>
): Promise<T> {
  const started = performance.now()
  evidence.steps.push(`START ${name}`)
  try {
    const result = await test.step(name, action)
    evidence.steps.push(`PASS  ${name} (${Math.round(performance.now() - started)} ms)`)
    return result
  } catch (error) {
    evidence.steps.push(`FAIL  ${name} (${Math.round(performance.now() - started)} ms)`)
    throw error
  }
}

async function initialSignature(page: Page): Promise<unknown> {
  return {
    title: await page.title(),
    protocol: new URL(page.url()).protocol,
    scenario: new URL(page.url()).searchParams.get('scenario'),
    project: await page.getByLabel('切换项目').inputValue(),
    panelCount: await page.getByRole('group', { name: 'Agent 面板' }).count(),
    tabs: await page.getByRole('tab').allTextContents(),
    viewport: await page.evaluate<{ width: number; height: number }>(
      '({ width: window.innerWidth, height: window.innerHeight })'
    )
  }
}

const NETWORK_PROBE_URLS = {
  http: 'https://ui-smoke.invalid/http-probe',
  websocket: 'wss://ui-smoke.invalid/websocket-probe'
} as const

async function probeNetworkGuard(page: Page): Promise<{
  readonly http: 'blocked' | 'escaped'
  readonly websocket: 'blocked' | 'escaped' | 'timeout'
}> {
  return page.evaluate(async (urls) => {
    const http = await fetch(urls.http).then(
      () => 'escaped' as const,
      () => 'blocked' as const
    )
    const websocket = await new Promise<'blocked' | 'escaped' | 'timeout'>(
      (resolveResult) => {
        let settled = false
        const finish = (result: 'blocked' | 'escaped' | 'timeout') => {
          if (settled) return
          settled = true
          resolveResult(result)
        }
        try {
          const socket = new WebSocket(urls.websocket)
          const timeout = setTimeout(() => {
            socket.close()
            finish('timeout')
          }, 2_000)
          socket.addEventListener(
            'open',
            () => {
              clearTimeout(timeout)
              socket.close()
              finish('escaped')
            },
            { once: true }
          )
          socket.addEventListener(
            'error',
            () => {
              clearTimeout(timeout)
              finish('blocked')
            },
            { once: true }
          )
        } catch {
          finish('blocked')
        }
      }
    )
    return { http, websocket }
  }, NETWORK_PROBE_URLS)
}

async function attachTextEvidence(
  testInfo: TestInfo,
  name: string,
  lines: readonly string[]
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(lines.join('\n') || '(empty)'),
    contentType: 'text/plain'
  })
}

test('1280×800 deterministic Electron smoke covers the core workspace', async ({}, testInfo) => {
  const started = performance.now()
  const evidence: SmokeEvidence = {
    blockedNetworkRequests: [],
    completedExternalRequests: [],
    console: [],
    rendererErrors: [],
    steps: []
  }
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

      const workspaceMain = page.getByRole('main')
      const overflow = await workspaceMain.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        scrollLeft: element.scrollLeft
      }))
      expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth)
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

      const fourthPanel = panels.filter({
        has: page.getByRole('tab', { name: /^cc_etl\b/ })
      })
      await expect(fourthPanel).toHaveCount(1)
      await workspaceMain.evaluate((element) => {
        element.scrollTo({ left: element.scrollWidth, behavior: 'instant' })
      })
      await expect
        .poll(() => workspaceMain.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(overflow.scrollLeft)
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
    await attachTextEvidence(testInfo, 'console.log', evidence.console)
    await attachTextEvidence(
      testInfo,
      'renderer-errors.log',
      evidence.rendererErrors
    )
    await attachTextEvidence(testInfo, 'steps.log', evidence.steps)
    await testInfo.attach('mock-scenario.json', {
      body: Buffer.from(JSON.stringify(SCENARIO, null, 2)),
      contentType: 'application/json'
    })
    await attachTextEvidence(
      testInfo,
      'blocked-network-requests.log',
      evidence.blockedNetworkRequests
    )
    await attachTextEvidence(
      testInfo,
      'completed-external-requests.log',
      evidence.completedExternalRequests
    )
  }
})
