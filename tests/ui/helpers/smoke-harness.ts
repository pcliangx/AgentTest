/**
 * Shared Electron smoke-test infrastructure.
 *
 * Every spec in `tests/ui/` reuses the same launch/connect/teardown/evidence
 * pipeline so that individual spec files can focus on coverage steps without
 * duplicating the process-lifecycle, network-guard and failure-capture logic.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import type {
  ElectronApplication,
  Page,
  TestInfo
} from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { UI_SMOKE_SCENARIO } from '../../../src/shared/ui-smoke-scenario'

const require = createRequire(resolve(process.cwd(), 'package.json'))
export const electronExecutablePath = require('electron') as string

// ---------------------------------------------------------------------------
// Evidence bag
// ---------------------------------------------------------------------------

export interface SmokeEvidence {
  readonly blockedNetworkRequests: string[]
  readonly completedExternalRequests: string[]
  readonly console: string[]
  readonly rendererErrors: string[]
  readonly steps: string[]
}

export function createEvidence(): SmokeEvidence {
  return {
    blockedNetworkRequests: [],
    completedExternalRequests: [],
    console: [],
    rendererErrors: [],
    steps: []
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

type LaunchLabel = 'first' | 'second'

export interface SmokeSession {
  readonly app: ElectronApplication
  page?: Page
  readonly pid: number
  readonly launchLabel: LaunchLabel
  readonly userDataPath: string
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

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

export function sanitizedEnvironment(
  userDataPath: string
): Record<string, string> {
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

export async function launchSmokeApplication(
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
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true
    })

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

export async function connectSmokeWindow(
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

// ---------------------------------------------------------------------------
// Network guard
// ---------------------------------------------------------------------------

interface BlockedNetworkRequest {
  readonly url: string
  readonly resourceType: string
}

export async function readBlockedNetworkRequests(
  session: SmokeSession
): Promise<BlockedNetworkRequest[]> {
  try {
    const contents = await readFile(
      join(
        session.userDataPath,
        UI_SMOKE_SCENARIO.networkEvidenceFile
      ),
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

export async function collectBlockedNetworkEvidence(
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

export const NETWORK_PROBE_URLS = {
  http: 'https://ui-smoke.invalid/http-probe',
  websocket: 'wss://ui-smoke.invalid/websocket-probe'
} as const

export async function probeNetworkGuard(page: Page): Promise<{
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

// ---------------------------------------------------------------------------
// Error assertions
// ---------------------------------------------------------------------------

export async function expectNoRendererErrors(
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

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export async function stopSmokeSession(
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

// ---------------------------------------------------------------------------
// Failure capture
// ---------------------------------------------------------------------------

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

export async function captureFailure(
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
        body: Buffer.from(
          'Electron exited before a Playwright trace was available.'
        ),
        contentType: 'text/plain'
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Recorded step wrapper
// ---------------------------------------------------------------------------

export async function recordedStep<T>(
  evidence: SmokeEvidence,
  name: string,
  action: () => Promise<T>
): Promise<T> {
  const started = performance.now()
  evidence.steps.push(`START ${name}`)
  try {
    const result = await test.step(name, action)
    evidence.steps.push(
      `PASS  ${name} (${Math.round(performance.now() - started)} ms)`
    )
    return result
  } catch (error) {
    evidence.steps.push(
      `FAIL  ${name} (${Math.round(performance.now() - started)} ms)`
    )
    throw error
  }
}

// ---------------------------------------------------------------------------
// Evidence attachment
// ---------------------------------------------------------------------------

export async function attachTextEvidence(
  testInfo: TestInfo,
  name: string,
  lines: readonly string[]
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(lines.join('\n') || '(empty)'),
    contentType: 'text/plain'
  })
}

export async function attachAllEvidence(
  testInfo: TestInfo,
  evidence: SmokeEvidence,
  scenario: Record<string, unknown>
): Promise<void> {
  await attachTextEvidence(testInfo, 'console.log', evidence.console)
  await attachTextEvidence(testInfo, 'renderer-errors.log', evidence.rendererErrors)
  await attachTextEvidence(testInfo, 'steps.log', evidence.steps)
  await testInfo.attach('mock-scenario.json', {
    body: Buffer.from(JSON.stringify(scenario, null, 2)),
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

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

export async function initialSignature(page: Page): Promise<unknown> {
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