// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  CommandResult,
  WorkbenchCommand,
  WorkbenchEvent,
  WorkbenchPort,
  WorkbenchViewModel
} from './workbench/contract'
import { id } from './workbench/contract'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'
import { createStandardScenario } from './workbench/standard-scenario'
import { ProjectShell } from './project-shell'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

/** Installs recorders for every renderer-to-main capability boundary. */
function installApiSpies(): Window['api'] {
  const api: Window['api'] = {
    run: vi.fn(async () => ({ ok: true as const })),
    cancel: vi.fn(async () => true),
    terminalOpen: vi.fn(async () => ({ ok: true as const })),
    terminalClose: vi.fn(async () => true),
    ptyInput: vi.fn(),
    ptyResize: vi.fn(),
    onPtyData: vi.fn(() => () => {}),
    onAgentEvent: vi.fn(() => () => {}),
    pickRepo: vi.fn(async () => ({ ok: false as const, reason: 'not used' })),
    getCurrentRepo: vi.fn(async () => null),
    worktreeStatus: vi.fn(async () => ({
      exists: false,
      files: [],
      summary: null
    })),
    worktreeOpen: vi.fn(async () => false),
    worktreeApply: vi.fn(async () => ({
      ok: false as const,
      reason: 'not used'
    }))
  }
  Object.defineProperty(window, 'api', {
    value: api,
    configurable: true
  })
  return api
}

/**
 * Wraps a MockScenarioAdapter and records every dispatched command, so tests
 * can assert that the renderer sent the expected typed Command (and only that).
 * The wrapper still serves the real scenario snapshots so navigation works.
 */
class RecordingPort implements WorkbenchPort {
  private readonly inner: MockScenarioAdapter
  readonly commands: WorkbenchCommand[] = []

  constructor(snapshot: WorkbenchViewModel = createStandardScenario()) {
    this.inner = new MockScenarioAdapter(snapshot)
  }

  async getSnapshot(): Promise<WorkbenchViewModel> {
    return this.inner.getSnapshot()
  }

  planDispatch: WorkbenchPort['planDispatch'] = (request) =>
    this.inner.planDispatch(request)

  async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    this.commands.push(command)
    return this.inner.dispatch(command)
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }
}

/**
 * Keeps one configured command kind pending after the real adapter accepts it.
 * This models the WorkbenchPort contract's allowed event-before-response
 * ordering and makes duplicate user activation deterministic.
 */
class DeferredCommandPort implements WorkbenchPort {
  private readonly inner: MockScenarioAdapter
  private readonly pending: Array<{
    result: Promise<CommandResult>
    resolve: (result: CommandResult) => void
  }> = []
  readonly commands: WorkbenchCommand[] = []

  constructor(
    private readonly deferredKind: WorkbenchCommand['kind'],
    snapshot: WorkbenchViewModel = createStandardScenario()
  ) {
    this.inner = new MockScenarioAdapter(snapshot)
  }

  getSnapshot(): Promise<WorkbenchViewModel> {
    return this.inner.getSnapshot()
  }

  planDispatch: WorkbenchPort['planDispatch'] = (request) =>
    this.inner.planDispatch(request)

  dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    this.commands.push(command)
    const result = this.inner.dispatch(command)
    if (command.kind !== this.deferredKind) return result
    return new Promise((resolve) => {
      this.pending.push({ result, resolve })
    })
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }

  async resolvePending(): Promise<void> {
    const pending = this.pending.splice(0)
    const results = await Promise.all(pending.map((item) => item.result))
    pending.forEach((item, index) => item.resolve(results[index]))
    await Promise.resolve()
  }
}

/**
 * Keeps command responses pending while allowing an authoritative snapshot
 * event to arrive first, as permitted by the WorkbenchPort ordering contract.
 */
class DeferredMutableSnapshotPort implements WorkbenchPort {
  private snapshot: WorkbenchViewModel
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>()
  private readonly pending: Array<{
    command: WorkbenchCommand
    resolve: (result: CommandResult) => void
  }> = []
  readonly commands: WorkbenchCommand[] = []

  constructor(snapshot: WorkbenchViewModel = createStandardScenario()) {
    this.snapshot = structuredClone(snapshot)
  }

  async getSnapshot(): Promise<WorkbenchViewModel> {
    return structuredClone(this.snapshot)
  }

  planDispatch: WorkbenchPort['planDispatch'] = (request) =>
    new MockScenarioAdapter(this.snapshot).planDispatch(request)

  dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    this.commands.push(command)
    return new Promise((resolve) => {
      this.pending.push({ command, resolve })
    })
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(mutate: (snapshot: WorkbenchViewModel) => void): void {
    const next = structuredClone(this.snapshot)
    mutate(next)
    next.revision += 1
    this.snapshot = next
    const event: WorkbenchEvent = {
      kind: 'view-model-updated',
      revision: next.revision,
      snapshot: structuredClone(next)
    }
    for (const listener of [...this.listeners]) listener(event)
  }

  async resolvePending(): Promise<void> {
    const pending = this.pending.splice(0)
    for (const { command, resolve } of pending) {
      resolve({
        ok: true,
        commandId: command.commandId,
        acceptedRevision: command.expectedRevision + 1
      })
    }
    await Promise.resolve()
  }
}

/** Supplies a caller-owned scenario at the WorkbenchPort boundary. */
class SnapshotRecordingPort implements WorkbenchPort {
  readonly commands: WorkbenchCommand[] = []

  constructor(private readonly snapshot: WorkbenchViewModel) {}

  async getSnapshot(): Promise<WorkbenchViewModel> {
    return structuredClone(this.snapshot)
  }

  planDispatch: WorkbenchPort['planDispatch'] = (request) =>
    new MockScenarioAdapter(this.snapshot).planDispatch(request)

  async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    this.commands.push(command)
    return {
      ok: true,
      commandId: command.commandId,
      acceptedRevision: this.snapshot.revision + 1
    }
  }

  subscribe(): () => void {
    return () => {}
  }
}

/** Publishes caller-controlled authoritative snapshot updates. */
class MutableSnapshotRecordingPort implements WorkbenchPort {
  private snapshot: WorkbenchViewModel
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>()
  readonly commands: WorkbenchCommand[] = []

  constructor(snapshot: WorkbenchViewModel) {
    this.snapshot = structuredClone(snapshot)
  }

  async getSnapshot(): Promise<WorkbenchViewModel> {
    return structuredClone(this.snapshot)
  }

  planDispatch: WorkbenchPort['planDispatch'] = (request) =>
    new MockScenarioAdapter(this.snapshot).planDispatch(request)

  async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    this.commands.push(command)
    return {
      ok: true,
      commandId: command.commandId,
      acceptedRevision: this.snapshot.revision + 1
    }
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(mutate: (snapshot: WorkbenchViewModel) => void): void {
    const next = structuredClone(this.snapshot)
    mutate(next)
    next.revision += 1
    this.snapshot = next
    const event: WorkbenchEvent = {
      kind: 'view-model-updated',
      revision: next.revision,
      snapshot: structuredClone(next)
    }
    for (const listener of [...this.listeners]) listener(event)
  }
}

/** Controls plan response order independently from authoritative snapshots. */
class DeferredPlanPort implements WorkbenchPort {
  private snapshot: WorkbenchViewModel
  private readonly listeners = new Set<(event: WorkbenchEvent) => void>()
  private readonly pendingPlans: Array<{
    request: Parameters<WorkbenchPort['planDispatch']>[0]
    snapshot: WorkbenchViewModel
    resolve: (
      result: Awaited<ReturnType<WorkbenchPort['planDispatch']>>
    ) => void
  }> = []
  readonly commands: WorkbenchCommand[] = []

  constructor(snapshot: WorkbenchViewModel = createStandardScenario()) {
    this.snapshot = structuredClone(snapshot)
  }

  get pendingPlanCount(): number {
    return this.pendingPlans.length
  }

  async getSnapshot(): Promise<WorkbenchViewModel> {
    return structuredClone(this.snapshot)
  }

  planDispatch(
    request: Parameters<WorkbenchPort['planDispatch']>[0]
  ): ReturnType<WorkbenchPort['planDispatch']> {
    return new Promise((resolve) => {
      this.pendingPlans.push({
        request,
        snapshot: structuredClone(this.snapshot),
        resolve
      })
    })
  }

  async resolvePlan(index: number): Promise<void> {
    const pending = this.pendingPlans[index]
    if (!pending) throw new Error(`Missing pending plan ${index}`)
    pending.resolve(
      await new MockScenarioAdapter(pending.snapshot).planDispatch(
        pending.request
      )
    )
    await Promise.resolve()
  }

  async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    this.commands.push(command)
    return {
      ok: true,
      commandId: command.commandId,
      acceptedRevision: this.snapshot.revision + 1
    }
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(mutate: (snapshot: WorkbenchViewModel) => void): void {
    const next = structuredClone(this.snapshot)
    mutate(next)
    next.revision += 1
    this.snapshot = next
    const event: WorkbenchEvent = {
      kind: 'view-model-updated',
      revision: next.revision,
      snapshot: structuredClone(next)
    }
    for (const listener of [...this.listeners]) listener(event)
  }
}

/** Rejects one plan query so the UI's explicit retry path is observable. */
class RejectOncePlanPort implements WorkbenchPort {
  private readonly inner = new MockScenarioAdapter()
  private rejected = false

  getSnapshot(): Promise<WorkbenchViewModel> {
    return this.inner.getSnapshot()
  }

  async planDispatch(
    request: Parameters<WorkbenchPort['planDispatch']>[0]
  ): ReturnType<WorkbenchPort['planDispatch']> {
    if (!this.rejected) {
      this.rejected = true
      const snapshot = await this.inner.getSnapshot()
      return {
        ok: false,
        reason: 'unavailable',
        latestRevision: snapshot.revision,
        message: '规划服务暂时不可用'
      }
    }
    return this.inner.planDispatch(request)
  }

  dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    return this.inner.dispatch(command)
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }
}

/** Forces a stale plan response without an event; the shell must refresh. */
class StalePlanRefreshPort implements WorkbenchPort {
  private readonly initial = createStandardScenario()
  private readonly latest = (() => {
    const next = structuredClone(this.initial)
    const project = next.projects[0]
    const target = next.agents.find((agent) => agent.name === 'cc_data')!
    next.revision += 1
    next.queue.push({
      queueItemId: id('queue-refresh', 'QueueItemId'),
      projectId: project.projectId,
      agentInstanceId: target.agentInstanceId,
      position: 3,
      priority: 'normal'
    })
    project.queuedRunCount = 3
    next.global.concurrency.queuedGlobal = next.queue.length
    return next
  })()
  private serveLatest = false
  readonly plannedRevisions: number[] = []
  readonly commands: WorkbenchCommand[] = []

  async getSnapshot(): Promise<WorkbenchViewModel> {
    return structuredClone(this.serveLatest ? this.latest : this.initial)
  }

  async planDispatch(
    request: Parameters<WorkbenchPort['planDispatch']>[0]
  ): ReturnType<WorkbenchPort['planDispatch']> {
    this.plannedRevisions.push(request.expectedRevision)
    if (!this.serveLatest) {
      this.serveLatest = true
      return {
        ok: false,
        reason: 'stale-revision',
        latestRevision: this.latest.revision,
        message: 'revision 已过期'
      }
    }
    return new MockScenarioAdapter(this.latest).planDispatch(request)
  }

  async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    this.commands.push(command)
    return {
      ok: true,
      commandId: command.commandId,
      acceptedRevision: this.latest.revision + 1
    }
  }

  subscribe(): () => void {
    return () => {}
  }
}

/** Renders the shell, navigates to the Agents surface and returns helpers. */
async function gotoAgentsSurface(port = new RecordingPort()) {
  const user = userEvent.setup()
  render(<ProjectShell port={port} />)
  await screen.findByRole('button', { name: '概览' })
  await user.click(screen.getByRole('button', { name: 'Agent' }))
  await screen.findByRole('region', { name: 'Agent 目录' })
  return { user, port }
}

/**
 * Opens the unified Dispatch Picker via the header command entry. The picker
 * is a shell-level surface reachable from any project surface (#6 P1-1), so
 * tests target the global header button rather than surface-specific ones.
 */
async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  // The header button is the global entry; use it to avoid the ambiguity of
  // multiple surface-level triggers.
  const headerButtons = screen.getAllByRole('button', { name: '派发给 Agent' })
  await user.click(headerButtons[0])
  return screen.findByRole('dialog', { name: '派发给 Agent' })
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1 — Agent Tab composer targets only the current instance
// ---------------------------------------------------------------------------

describe('Dispatch — Agent Tab composer', () => {
  it('previews and executes the Project queue position for a Ready Agent at capacity', async () => {
    const scenario = createStandardScenario()
    scenario.agents.find((agent) => agent.name === 'cc_etl')!.runtimeState =
      'finishing'
    const port = new RecordingPort(scenario)
    const { user } = await gotoAgentsSurface(port)
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(
      within(directory).getByRole('button', { name: /^cx_review/ })
    )
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))

    expect(
      within(view).getByRole('log', { name: '对话记录' })
    ).toHaveTextContent('当前 Project 已有 2 项排队；新指令将进入第 3 位。')
    const plannedRevision = (await port.getSnapshot()).revision

    await user.type(
      within(view).getByRole('textbox', { name: '发送给 cx_review' }),
      'queue from composer'
    )
    await user.click(
      within(view).getByRole('button', { name: '发送给 cx_review' })
    )

    const after = await port.getSnapshot()
    const target = after.agents.find((agent) => agent.name === 'cx_review')!
    expect(target.runtimeState).toBe('queued')
    expect(
      port.commands.find(
        (command) => command.kind === 'send-agent-instruction'
      )?.expectedRevision
    ).toBe(plannedRevision)
    expect(
      after.queue.find(
        (item) => item.agentInstanceId === target.agentInstanceId
      )?.position
    ).toBe(3)
  })

  it('retries a failed Composer plan before enabling send', async () => {
    const port = new RejectOncePlanPort()
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    await user.click(screen.getByRole('button', { name: 'Agent' }))
    const view = await screen.findByRole('region', { name: 'Agent 视图' })

    expect(await within(view).findByRole('alert')).toHaveTextContent(
      '规划服务暂时不可用'
    )
    const composer = within(view).getByRole('textbox', {
      name: '发送给 cc_data'
    })
    await user.type(composer, 'retry from composer')
    expect(
      within(view).getByRole('button', { name: '发送给 cc_data' })
    ).toBeDisabled()

    await user.click(within(view).getByRole('button', { name: '重新计算' }))
    await waitFor(() =>
      expect(
        within(view).getByRole('log', { name: '对话记录' })
      ).toHaveTextContent('新指令将进入第 3 位')
    )
    expect(
      within(view).getByRole('button', { name: '发送给 cc_data' })
    ).toBeEnabled()
  })

  it('sends an instruction addressed only to the currently open AgentInstanceId', async () => {
    const { user, port } = await gotoAgentsSurface()
    // cc_data is open and active by default in the standard scenario.
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))

    const composer = within(view).getByRole('textbox', {
      name: /发送给 cc_data/
    })
    await user.type(composer, 'clean the Q2 pipeline')
    await user.click(
      within(view).getByRole('button', { name: '发送给 cc_data' })
    )

    const sent = port.commands.filter(
      (c) => c.kind === 'send-agent-instruction'
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      kind: 'send-agent-instruction',
      agentInstanceId: id('inst-cc-data', 'AgentInstanceId'),
      instruction: 'clean the Q2 pipeline'
    })
  })

  it('enqueues a running agent as start-or-queue (not reply-current-run)', async () => {
    const { user, port } = await gotoAgentsSurface()
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))
    // cc_data is in the `running` state in the standard scenario. Per
    // UX-v0.2 §6.3 only a needs-input Run may be replied to; a running agent
    // must enqueue as the next Run.
    await user.type(
      within(view).getByRole('textbox', { name: /发送给 cc_data/ }),
      'follow up'
    )
    await user.click(
      within(view).getByRole('button', { name: '发送给 cc_data' })
    )
    const sent = port.commands.find(
      (c) => c.kind === 'send-agent-instruction'
    )!
    expect(sent).toMatchObject({ mode: 'start-or-queue' })
  })

  it('replies to a needs-input agent as reply-current-run', async () => {
    const { user, port } = await gotoAgentsSurface()
    // cc_sql is in the `needs-input` state in the standard scenario — open it.
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cc_sql/ }))
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))
    await user.type(
      within(view).getByRole('textbox', { name: /发送给 cc_sql/ }),
      'here is the input'
    )
    await user.click(
      within(view).getByRole('button', { name: '发送给 cc_sql' })
    )
    const sent = port.commands.find(
      (c) => c.kind === 'send-agent-instruction'
    )!
    expect(sent).toMatchObject({ mode: 'reply-current-run' })
  })

  it('blocks the composer while Terminal takeover is active', async () => {
    const { user, port } = await gotoAgentsSurface()
    // cx_anti holds an active Terminal takeover in the standard scenario.
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cx_anti/ }))
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))
    // Composer must be disabled and explain the Terminal mutex.
    expect(view).toHaveTextContent('Terminal 接管中')
    expect(
      within(view).getByRole('textbox', { name: /发送给 cx_anti/ })
    ).toBeDisabled()
    expect(
      port.commands.filter((c) => c.kind === 'send-agent-instruction')
    ).toHaveLength(0)
  })

  it('blocks the composer while Terminal takeover is opening', async () => {
    const snapshot = createStandardScenario()
    snapshot.projects[0].currentSurface = 'agents'
    // Land on the project (not the #76 home page) as these tests expect.
    snapshot.activeGlobalSurface = undefined
    snapshot.agents.find((agent) => agent.name === 'cc_data')!.terminalState =
      'opening'
    const port = new SnapshotRecordingPort(snapshot)
    render(<ProjectShell port={port} />)

    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    expect(view).toHaveTextContent('Terminal 正在打开或接管中')
    expect(
      within(view).getByRole('textbox', { name: /发送给 cc_data/ })
    ).toBeDisabled()
    expect(port.commands).toHaveLength(0)
  })

  it('blocks both composer and Picker when the Project is archived', async () => {
    const snapshot = createStandardScenario()
    snapshot.projects[0].lifecycle = 'archived'
    snapshot.projects[0].currentSurface = 'agents'
    // Land on the project (not the #76 home page) as these tests expect.
    snapshot.activeGlobalSurface = undefined
    const port = new SnapshotRecordingPort(snapshot)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)

    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    expect(view).toHaveTextContent('Project 已归档')
    expect(
      within(view).getByRole('textbox', { name: /发送给 cc_data/ })
    ).toBeDisabled()

    const dialog = await openPicker(user)
    expect(dialog).toHaveTextContent('Project 已归档，不能创建新派发')
    expect(
      within(dialog).getByRole('button', { name: /cx_review/ })
    ).toBeDisabled()
    expect(
      within(dialog).getByRole('button', { name: '确认派发' })
    ).toBeDisabled()
    expect(port.commands).toHaveLength(0)
  })

  it('blocks both composer and Picker when the Project Root is unavailable', async () => {
    const snapshot = createStandardScenario()
    snapshot.projects[0].rootAvailability = 'unavailable'
    snapshot.projects[0].currentSurface = 'agents'
    // Land on the project (not the #76 home page) as these tests expect.
    snapshot.activeGlobalSurface = undefined
    const port = new SnapshotRecordingPort(snapshot)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)

    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    expect(view).toHaveTextContent('Project Root 不可用')
    expect(
      within(view).getByRole('textbox', { name: /发送给 cc_data/ })
    ).toBeDisabled()

    const dialog = await openPicker(user)
    expect(dialog).toHaveTextContent('Project Root 不可用，不能创建新派发')
    expect(
      within(dialog).getByRole('button', { name: /cx_review/ })
    ).toBeDisabled()
    expect(
      within(dialog).getByRole('button', { name: '确认派发' })
    ).toBeDisabled()
    expect(port.commands).toHaveLength(0)
  })

  it('blocks both composer and Picker when the Project repository is not ready', async () => {
    const snapshot = createStandardScenario()
    snapshot.projects[0].repositoryReadiness = 'not-ready'
    snapshot.projects[0].currentSurface = 'agents'
    // Land on the project (not the #76 home page) as these tests expect.
    snapshot.activeGlobalSurface = undefined
    const port = new SnapshotRecordingPort(snapshot)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)

    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    expect(view).toHaveTextContent('Project 尚未初始化或绑定 Git 仓库')
    expect(
      within(view).getByRole('textbox', { name: /发送给 cc_data/ })
    ).toBeDisabled()

    const dialog = await openPicker(user)
    expect(dialog).toHaveTextContent(
      'Project 尚未初始化或绑定 Git 仓库，不能创建新派发'
    )
    expect(
      within(dialog).getByRole('button', { name: /cx_review/ })
    ).toBeDisabled()
    expect(
      within(dialog).getByRole('button', { name: '确认派发' })
    ).toBeDisabled()
    expect(port.commands).toHaveLength(0)
  })

  it('explains why the composer is disabled for an archived Agent', async () => {
    const snapshot = createStandardScenario()
    snapshot.projects[0].currentSurface = 'agents'
    // Land on the project (not the #76 home page) as these tests expect.
    snapshot.activeGlobalSurface = undefined
    snapshot.agents.find((agent) => agent.name === 'cc_data')!.runtimeState =
      'archived'
    const port = new SnapshotRecordingPort(snapshot)
    render(<ProjectShell port={port} />)

    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    expect(view).toHaveTextContent('Agent 已归档')
    expect(
      within(view).getByRole('textbox', { name: /发送给 cc_data/ })
    ).toBeDisabled()
    expect(port.commands).toHaveLength(0)
  })

  it('addresses an idle agent as start-or-queue', async () => {
    const { user, port, ...rest } = await gotoAgentsSurface()
    void rest
    // cx_review is ready (idle) in the standard scenario — open it first.
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /^cx_review/ }))
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))
    await user.type(
      within(view).getByRole('textbox', { name: /发送给 cx_review/ }),
      'kick off'
    )
    await user.click(
      within(view).getByRole('button', { name: '发送给 cx_review' })
    )
    const sent = port.commands.find(
      (c) => c.kind === 'send-agent-instruction'
    )!
    expect(sent).toMatchObject({
      agentInstanceId: id('inst-cx-review', 'AgentInstanceId'),
      mode: 'start-or-queue'
    })
  })

  it('submits only once while an instruction response is pending', async () => {
    const user = userEvent.setup()
    const port = new DeferredCommandPort('send-agent-instruction')
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    await user.click(screen.getByRole('button', { name: 'Agent' }))
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))
    await user.type(
      within(view).getByRole('textbox', { name: /发送给 cc_data/ }),
      'enqueue once'
    )
    const send = within(view).getByRole('button', {
      name: '发送给 cc_data'
    })

    await user.click(send)
    await user.click(send)

    try {
      expect(
        port.commands.filter(
          (command) => command.kind === 'send-agent-instruction'
        )
      ).toHaveLength(1)
    } finally {
      await act(() => port.resolvePending())
    }
  })

  it('shows the next queue position for an already-queued agent', async () => {
    const { user } = await gotoAgentsSurface()
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(
      within(directory).getByRole('button', { name: /^cx_forecast/ })
    )
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))

    expect(
      within(view).getByRole('log', { name: '对话记录' })
    ).toHaveTextContent('当前 Project 已有 2 项排队；新指令将进入第 3 位。')
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 2 — Agent Picker, chips, @@ parsing
// ---------------------------------------------------------------------------

describe('Dispatch — Agent Picker and @@ routing', () => {
  it('shows unique capacity-aware queue positions for an ordered busy batch', async () => {
    const { user, port } = await gotoAgentsSurface()
    const before = await port.getSnapshot()
    const dialog = await openPicker(user)

    await user.click(
      within(dialog).getByRole('button', { name: /^cc_data/ })
    )
    await user.click(
      within(dialog).getByRole('button', { name: /^cx_anti/ })
    )
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'queue in order'
    )

    const preview = within(dialog).getByRole('region', { name: '派发预览' })
    expect(preview).toHaveTextContent('cc_data: 第 3 位')
    expect(preview).toHaveTextContent('cx_anti: 第 4 位')

    await user.click(within(dialog).getByRole('button', { name: '确认派发' }))
    const command = port.commands.find(
      (candidate) => candidate.kind === 'confirm-dispatch'
    )!
    expect(command.expectedRevision).toBe(before.revision)
    const after = await port.getSnapshot()
    expect(
      after.queue
        .filter((item) =>
          command.targets.includes(item.agentInstanceId)
        )
        .map((item) => item.position)
    ).toEqual([3, 4])
  })

  it('previews and executes a batch that crosses the final Project slot', async () => {
    const { user, port } = await gotoAgentsSurface()
    const dialog = await openPicker(user)
    await user.click(
      within(dialog).getByRole('button', { name: /^cx_review/ })
    )
    await user.click(
      within(dialog).getByRole('button', { name: /^kimi_visual/ })
    )
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'cross the final slot'
    )

    const preview = within(dialog).getByRole('region', { name: '派发预览' })
    expect(preview).toHaveTextContent('cx_review: 无需排队')
    expect(preview).toHaveTextContent('kimi_visual: 第 3 位')

    await user.click(within(dialog).getByRole('button', { name: '确认派发' }))
    const after = await port.getSnapshot()
    expect(
      after.agents.find((agent) => agent.name === 'cx_review')!.runtimeState
    ).toBe('running')
    expect(
      after.queue.find(
        (item) =>
          item.agentInstanceId ===
          after.agents.find((agent) => agent.name === 'kimi_visual')!
            .agentInstanceId
      )?.position
    ).toBe(3)
  })

  it('ignores an older plan response and confirms against the visible plan revision', async () => {
    const initial = createStandardScenario()
    const project = initial.projects[0]
    const target = initial.agents.find((agent) => agent.name === 'cc_data')!
    const port = new DeferredPlanPort(initial)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const dialog = await openPicker(user)
    await user.click(
      within(dialog).getByRole('button', { name: /^cc_data/ })
    )
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'use the visible plan'
    )
    await waitFor(() => expect(port.pendingPlanCount).toBe(1))
    const preview = within(dialog).getByRole('region', { name: '派发预览' })
    const planStatus = within(preview).getByRole('status', {
      name: '派发计划状态'
    })
    expect(preview).not.toHaveAttribute('aria-live')
    expect(planStatus).toHaveAttribute('aria-live', 'polite')
    expect(planStatus).toHaveAttribute('aria-busy', 'true')

    await act(() =>
      port.publish((next) => {
        next.queue.push({
          queueItemId: id('queue-external', 'QueueItemId'),
          projectId: project.projectId,
          agentInstanceId: target.agentInstanceId,
          position: 3,
          priority: 'normal'
        })
        next.projects[0].queuedRunCount = 3
        next.global.concurrency.queuedGlobal = next.queue.length
      })
    )
    await waitFor(() => expect(port.pendingPlanCount).toBe(2))

    await act(() => port.resolvePlan(1))
    await waitFor(() => expect(preview).toHaveTextContent('cc_data: 第 4 位'))
    expect(planStatus).toHaveAttribute('aria-busy', 'false')

    await act(() => port.resolvePlan(0))
    expect(preview).toHaveTextContent('cc_data: 第 4 位')
    expect(preview).not.toHaveTextContent('cc_data: 第 3 位')

    await user.click(within(dialog).getByRole('button', { name: '确认派发' }))
    expect(
      port.commands.find((command) => command.kind === 'confirm-dispatch')
        ?.expectedRevision
    ).toBe(initial.revision + 1)
  })

  it('keeps confirmation blocked after a plan failure and offers an explicit retry', async () => {
    const port = new RejectOncePlanPort()
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const dialog = await openPicker(user)
    await user.click(
      within(dialog).getByRole('button', { name: /^cc_data/ })
    )
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'retry the plan'
    )

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '规划服务暂时不可用'
    )
    expect(
      within(dialog).getByRole('button', { name: '确认派发' })
    ).toBeDisabled()

    await user.click(within(dialog).getByRole('button', { name: '重新计算' }))
    await waitFor(() =>
      expect(
        within(dialog).getByRole('region', { name: '派发预览' })
      ).toHaveTextContent('cc_data: 第 3 位')
    )
    expect(
      within(dialog).getByRole('button', { name: '确认派发' })
    ).toBeEnabled()
  })

  it('refreshes the snapshot after a stale plan response even when no event arrives', async () => {
    const port = new StalePlanRefreshPort()
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const dialog = await openPicker(user)
    await user.click(
      within(dialog).getByRole('button', { name: /^cc_data/ })
    )
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'refresh stale planning state'
    )

    const preview = within(dialog).getByRole('region', { name: '派发预览' })
    await waitFor(() => expect(preview).toHaveTextContent('cc_data: 第 4 位'))
    expect(port.plannedRevisions).toEqual([0, 1])

    await user.click(within(dialog).getByRole('button', { name: '确认派发' }))
    expect(
      port.commands.find((command) => command.kind === 'confirm-dispatch')
        ?.expectedRevision
    ).toBe(1)
  })

  it('opens the Agent Picker, selects multiple targets shown as chips, previews, and confirms creating one dispatch per target', async () => {
    const { user, port } = await gotoAgentsSurface()
    const dialog = await openPicker(user)

    // Select two distinct targets from the same project.
    await user.click(within(dialog).getByRole('button', { name: /cx_review/ }))
    await user.click(within(dialog).getByRole('button', { name: /kimi_visual/ }))

    // Both selections render as visible chips with their agent names.
    const chips = within(dialog).getAllByRole('listitem', {
      name: /已选目标/
    })
    expect(chips).toHaveLength(2)
    expect(chips.some((c) => c.textContent?.includes('cx_review'))).toBe(true)
    expect(chips.some((c) => c.textContent?.includes('kimi_visual'))).toBe(true)

    // Type the shared instruction.
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'summarize the anomaly findings'
    )

    // The preview must reveal targets, instruction, resource scope and queue
    // position before the user confirms.
    const preview = within(dialog).getByRole('region', { name: '派发预览' })
    expect(preview).toHaveTextContent('cx_review')
    expect(preview).toHaveTextContent('kimi_visual')
    expect(preview).toHaveTextContent('summarize the anomaly findings')
    expect(preview).toHaveTextContent('队列位置')

    // Confirm dispatches one confirm-dispatch with both targets.
    await user.click(within(dialog).getByRole('button', { name: '确认派发' }))

    const confirms = port.commands.filter((c) => c.kind === 'confirm-dispatch')
    expect(confirms).toHaveLength(1)
    expect(confirms[0]).toMatchObject({
      kind: 'confirm-dispatch',
      targets: [
        id('inst-cx-review', 'AgentInstanceId'),
        id('inst-kimi-viz', 'AgentInstanceId')
      ],
      instruction: 'summarize the anomaly findings'
    })
  })

  it('cancelling the preview sends no Command', async () => {
    const { user, port } = await gotoAgentsSurface()
    const dialog = await openPicker(user)

    await user.click(within(dialog).getByRole('button', { name: /cx_review/ }))
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'draft a note'
    )
    await user.click(within(dialog).getByRole('button', { name: '取消' }))

    expect(
      port.commands.filter((c) => c.kind === 'confirm-dispatch')
    ).toHaveLength(0)
  })

  it('shows that an idle target does not need a queue position', async () => {
    const { user } = await gotoAgentsSurface()
    const dialog = await openPicker(user)

    // cx_review is idle and confirm-dispatch does not enqueue it in the mock.
    await user.click(within(dialog).getByRole('button', { name: /cx_review/ }))
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'start now'
    )

    const preview = within(dialog).getByRole('region', { name: '派发预览' })
    expect(preview).toHaveTextContent('cx_review: 无需排队')
    expect(preview).not.toHaveTextContent('cx_review: 第 1 位')
  })

  it('Escape closes the picker without dispatching', async () => {
    const { user, port } = await gotoAgentsSurface()
    const dialog = await openPicker(user)
    await user.click(within(dialog).getByRole('button', { name: /cx_review/ }))
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'draft'
    )
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: '派发给 Agent' })).toBeNull()
    expect(
      port.commands.filter((c) => c.kind === 'confirm-dispatch')
    ).toHaveLength(0)
  })

  it('moves focus into the picker and restores its opener after immediate Escape', async () => {
    const { user, port } = await gotoAgentsSurface()
    const opener = screen.getAllByRole('button', {
      name: '派发给 Agent'
    })[0]
    await user.click(opener)
    const dialog = await screen.findByRole('dialog', {
      name: '派发给 Agent'
    })

    expect(dialog).toHaveFocus()
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: '派发给 Agent' })).toBeNull()
    expect(opener).toHaveFocus()
    expect(
      port.commands.filter((command) => command.kind === 'confirm-dispatch')
    ).toHaveLength(0)
  })

  it('parses @@<agent-name> into visible chips and removes routing markers from the dispatched instruction', async () => {
    const { user, port } = await gotoAgentsSurface()
    const dialog = await openPicker(user)

    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      '@@cx_review @@kimi_visual summarize the anomaly'
    )

    // @@ references resolve to chips for the named instances.
    const parsed = within(dialog).getAllByRole('listitem', {
      name: /已选目标/
    })
    expect(parsed.some((c) => c.textContent?.includes('cx_review'))).toBe(true)
    expect(parsed.some((c) => c.textContent?.includes('kimi_visual'))).toBe(true)

    const preview = within(dialog).getByRole('region', { name: '派发预览' })
    expect(preview).toHaveTextContent('指令：summarize the anomaly')
    expect(preview).not.toHaveTextContent('@@cx_review')
    expect(preview).not.toHaveTextContent('@@kimi_visual')

    await user.click(within(dialog).getByRole('button', { name: '确认派发' }))
    expect(port.commands.find((c) => c.kind === 'confirm-dispatch')).toMatchObject({
      instruction: 'summarize the anomaly'
    })
  })

  it('recognizes an @@ target after punctuation without requiring left whitespace', async () => {
    const { user, port } = await gotoAgentsSurface()
    const target = (await port.getSnapshot()).agents.find(
      (agent) => agent.name === 'cx_review'
    )!
    const dialog = await openPicker(user)

    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'dispatch:@@cx_review inspect'
    )

    expect(
      within(dialog).getAllByRole('listitem', { name: /已选目标/ })
    ).toHaveLength(1)
    expect(
      within(dialog).getByRole('region', { name: '派发预览' })
    ).toHaveTextContent('指令：dispatch: inspect')

    await user.click(
      within(dialog).getByRole('button', { name: '确认派发' })
    )
    expect(port.commands.find((c) => c.kind === 'confirm-dispatch')).toMatchObject({
      kind: 'confirm-dispatch',
      targets: [target.agentInstanceId],
      instruction: 'dispatch: inspect'
    })
  })

  it('does not allow a routing marker to be the entire instruction', async () => {
    const { user, port } = await gotoAgentsSurface()
    const dialog = await openPicker(user)

    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      '@@cx_review'
    )

    expect(
      within(dialog).getByRole('button', { name: '确认派发' })
    ).toBeDisabled()
    expect(
      port.commands.filter((c) => c.kind === 'confirm-dispatch')
    ).toHaveLength(0)
  })

  it('blocks the whole dispatch while any explicit @@ target is unresolved', async () => {
    const { user, port } = await gotoAgentsSurface()
    const dialog = await openPicker(user)

    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      '@@cx_review @@typo investigate the failure'
    )

    expect(dialog).toHaveTextContent('未识别的名称：typo')
    expect(
      within(dialog).getByRole('button', { name: '确认派发' })
    ).toBeDisabled()
    expect(
      port.commands.filter((c) => c.kind === 'confirm-dispatch')
    ).toHaveLength(0)
  })

  it('does not misread @@all-review (a valid agent name) as an @@all broadcast', async () => {
    const snapshot = createStandardScenario()
    const target = snapshot.agents.find((agent) => agent.name === 'cx_review')!
    target.name = 'all-review'
    const port = new SnapshotRecordingPort(snapshot)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const dialog = await openPicker(user)
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      '@@all-review inspect'
    )

    expect(
      within(dialog).getAllByRole('listitem', { name: /已选目标/ })
    ).toHaveLength(1)
    expect(dialog).toHaveTextContent('all-review')
    expect(dialog).not.toHaveTextContent('@@all 已展开')

    await user.click(
      within(dialog).getByRole('button', { name: '确认派发' })
    )
    expect(port.commands.find((c) => c.kind === 'confirm-dispatch')).toMatchObject({
      kind: 'confirm-dispatch',
      targets: [target.agentInstanceId],
      instruction: 'inspect'
    })
  })

  it('uses a whitespace boundary for simple names and braces for exact names containing spaces', async () => {
    const snapshot = createStandardScenario()
    snapshot.agents.find((agent) => agent.name === 'cx_review')!.name = 'data'
    snapshot.agents.find((agent) => agent.name === 'kimi_visual')!.name =
      'data review'
    const port = new SnapshotRecordingPort(snapshot)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const dialog = await openPicker(user)
    const editor = within(dialog).getByRole('textbox', { name: '指令' })

    await user.type(editor, '@@data review the failure')
    let chips = within(dialog).getAllByRole('listitem', {
      name: /已选目标/
    })
    expect(chips.map((chip) => chip.textContent)).toEqual(['data'])
    expect(
      within(dialog).getByRole('region', { name: '派发预览' })
    ).toHaveTextContent('指令：review the failure')

    await user.clear(editor)
    await user.type(editor, '@@{{data review} investigate the failure')
    chips = within(dialog).getAllByRole('listitem', { name: /已选目标/ })
    expect(chips.map((chip) => chip.textContent)).toEqual(['data review'])
    expect(
      within(dialog).getByRole('region', { name: '派发预览' })
    ).toHaveTextContent('指令：investigate the failure')
  })

  it('routes an all-prefixed Agent Name through exact braced syntax without broadcasting', async () => {
    const snapshot = createStandardScenario()
    snapshot.agents.find((agent) => agent.name === 'cx_review')!.name =
      'all review'
    const port = new SnapshotRecordingPort(snapshot)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const dialog = await openPicker(user)

    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      '@@{{all review} inspect the findings'
    )

    expect(dialog).not.toHaveTextContent('@@all 已展开')
    const chips = within(dialog).getAllByRole('listitem', {
      name: /已选目标/
    })
    expect(chips.map((chip) => chip.textContent)).toEqual(['all review'])
    expect(
      within(dialog).getByRole('region', { name: '派发预览' })
    ).toHaveTextContent('指令：inspect the findings')
  })

  it('keeps exact @@all as a broadcast when an Agent Name is its prefix', async () => {
    const { user } = await gotoAgentsSurface()

    // `a` is a valid Agent Name. It must not consume the `@@a` prefix of the
    // reserved `@@all` token and turn an explicit broadcast into one target.
    await user.click(screen.getByRole('button', { name: '新建 Agent' }))
    await user.type(
      await screen.findByRole('textbox', { name: 'Agent 名称' }),
      'a'
    )
    await user.click(screen.getByRole('button', { name: '创建 Agent' }))

    const dialog = await openPicker(user)
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      '@@all'
    )

    expect(dialog).toHaveTextContent('已展开为当前 Project 全部实例')
    expect(
      within(dialog).getAllByRole('listitem', { name: /已选目标/ })
    ).toHaveLength(9)
  })

  it('expands @@all into every current Project instance and exposes blocked targets instead of silently narrowing it', async () => {
    const { user, port } = await gotoAgentsSurface()
    const dialog = await openPicker(user)

    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'stand up @@all'
    )

    // @@all surfaces the explicit instance list for the active project before
    // any dispatch happens.
    expect(dialog).toHaveTextContent('已展开为当前 Project 全部实例')

    // The standard sales project has 8 instances. @@all must name all eight,
    // including the unavailable target and the Terminal-active target, rather
    // than silently changing the meaning of "all".
    const expansion = within(dialog).getAllByRole('listitem', {
      name: /已选目标/
    })
    expect(expansion.length).toBe(8)
    expect(
      expansion.some((c) => c.textContent?.includes('kimi_docs'))
    ).toBe(true)
    expect(
      expansion.some((c) => c.textContent?.includes('cx_anti'))
    ).toBe(true)
    expect(dialog).toHaveTextContent('kimi_docs（不可派发）')
    expect(dialog).toHaveTextContent('cx_anti: 待全部目标可派发')

    // Atomic broadcast cannot proceed while one of the explicit targets is
    // unavailable; the user must fix availability or choose a narrower set.
    expect(
      within(dialog).getByRole('button', { name: '确认派发' })
    ).toBeDisabled()
    expect(
      port.commands.filter((c) => c.kind === 'confirm-dispatch').length
    ).toBe(0)
  })

  it('requires a second confirmation when every @@all target can accept a dispatch', async () => {
    const snapshot = createStandardScenario()
    const project = snapshot.projects[0]
    for (const agent of snapshot.agents.filter(
      (candidate) => candidate.projectId === project.projectId
    )) {
      agent.runtimeState = 'ready'
      agent.terminalState = 'closed'
      agent.queueDepth = 0
      delete agent.activeRunId
    }
    snapshot.queue = snapshot.queue.filter(
      (item) => item.projectId !== project.projectId
    )
    project.activeRunCount = 0
    project.queuedRunCount = 0
    snapshot.global.concurrency.activeGlobal = 0
    snapshot.global.concurrency.queuedGlobal = 0
    const port = new SnapshotRecordingPort(snapshot)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const dialog = await openPicker(user)

    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      '@@all stand up'
    )
    expect(
      within(dialog).getAllByRole('listitem', { name: /已选目标/ })
    ).toHaveLength(8)
    const preview = within(dialog).getByRole('region', { name: '派发预览' })
    for (const name of ['cc_data', 'cc_sql', 'cc_etl']) {
      expect(preview).toHaveTextContent(`${name}: 无需排队`)
    }
    for (const [name, position] of [
      ['cx_anti', 1],
      ['cx_forecast', 2],
      ['cx_review', 3],
      ['kimi_visual', 4],
      ['kimi_docs', 5]
    ] as const) {
      expect(preview).toHaveTextContent(`${name}: 第 ${position} 位`)
    }

    await user.click(within(dialog).getByRole('button', { name: '确认派发' }))
    const broadcastDialog = await screen.findByRole('dialog', {
      name: /确认广播/
    })
    expect(
      port.commands.filter((c) => c.kind === 'confirm-dispatch')
    ).toHaveLength(0)

    await user.click(
      within(broadcastDialog).getByRole('button', { name: '确认广播' })
    )
    const confirms = port.commands.filter((c) => c.kind === 'confirm-dispatch')
    expect(confirms).toHaveLength(1)
    expect(confirms[0]).toMatchObject({
      projectId: project.projectId,
      instruction: 'stand up',
      expectedRevision: snapshot.revision
    })
    expect(confirms[0].targets).toHaveLength(8)
  })

  it('keeps keyboard focus inside the nested broadcast confirmation', async () => {
    const snapshot = createStandardScenario()
    snapshot.agents.find((agent) => agent.name === 'kimi_docs')!.runtimeState =
      'ready'
    const port = new SnapshotRecordingPort(snapshot)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const pickerDialog = await openPicker(user)

    await user.type(
      within(pickerDialog).getByRole('textbox', { name: '指令' }),
      '@@all inspect focus'
    )
    await user.click(
      within(pickerDialog).getByRole('button', { name: '确认派发' })
    )
    const broadcastDialog = await screen.findByRole('dialog', {
      name: '确认广播派发'
    })
    const cancel = within(broadcastDialog).getByRole('button', {
      name: '取消'
    })
    const confirm = within(broadcastDialog).getByRole('button', {
      name: '确认广播'
    })

    expect(cancel).toHaveFocus()
    await user.tab({ shift: true })
    expect(confirm).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()

    // A programmatic focus move to the dialog container must still be treated
    // as a focus boundary rather than allowing Shift+Tab into the outer picker.
    broadcastDialog.focus()
    await user.tab({ shift: true })
    expect(confirm).toHaveFocus()
    expect(port.commands).toHaveLength(0)
  })

  it('cancels broadcast confirmation when the authoritative snapshot changes before the second confirmation', async () => {
    const snapshot = createStandardScenario()
    snapshot.agents.find((agent) => agent.name === 'kimi_docs')!.runtimeState =
      'ready'
    const port = new MutableSnapshotRecordingPort(snapshot)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const dialog = await openPicker(user)

    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      '@@all inspect the project'
    )
    await user.click(within(dialog).getByRole('button', { name: '确认派发' }))
    expect(
      await screen.findByRole('dialog', { name: '确认广播派发' })
    ).toHaveTextContent('8 个实例')

    await act(() =>
      port.publish((next) => {
        const template = next.agents.find(
          (agent) => agent.name === 'cx_review'
        )!
        next.agents.push({
          ...template,
          agentInstanceId: id('inst-late-agent', 'AgentInstanceId'),
          name: 'late_agent',
          queueDepth: 0,
          activeRunId: undefined
        })
      })
    )

    expect(
      screen.queryByRole('dialog', { name: '确认广播派发' })
    ).toBeNull()
    expect(dialog).toHaveTextContent('派发预览已变化，请重新确认广播')
    expect(
      port.commands.filter((command) => command.kind === 'confirm-dispatch')
    ).toHaveLength(0)

    await user.click(within(dialog).getByRole('button', { name: '确认派发' }))
    const refreshed = await screen.findByRole('dialog', {
      name: '确认广播派发'
    })
    expect(refreshed).toHaveTextContent('9 个实例')
    await user.click(
      within(refreshed).getByRole('button', { name: '确认广播' })
    )
    const commands = port.commands.filter(
      (command) => command.kind === 'confirm-dispatch'
    )
    expect(commands).toHaveLength(1)
    expect(commands[0].targets).toHaveLength(9)
  })

  it('keeps focus in the picker when an update disables the broadcast trigger', async () => {
    const snapshot = createStandardScenario()
    const project = snapshot.projects[0]
    snapshot.agents.find((agent) => agent.name === 'kimi_docs')!.runtimeState =
      'ready'
    const port = new MutableSnapshotRecordingPort(snapshot)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const pickerDialog = await openPicker(user)

    await user.type(
      within(pickerDialog).getByRole('textbox', { name: '指令' }),
      '@@all invalidate focus target'
    )
    await user.click(
      within(pickerDialog).getByRole('button', { name: '确认派发' })
    )
    expect(
      await screen.findByRole('dialog', { name: '确认广播派发' })
    ).toBeInTheDocument()

    await act(() =>
      port.publish((next) => {
        next.projects.find(
          (candidate) => candidate.projectId === project.projectId
        )!.lifecycle = 'archived'
      })
    )

    expect(
      screen.queryByRole('dialog', { name: '确认广播派发' })
    ).toBeNull()
    expect(
      within(pickerDialog).getByRole('button', { name: '确认派发' })
    ).toBeDisabled()
    expect(pickerDialog).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '派发给 Agent' })).toBeNull()
    expect(port.commands).toHaveLength(0)
  })

  it('excludes unavailable agents from the selectable list', async () => {
    const { user } = await gotoAgentsSurface()
    const dialog = await openPicker(user)
    // kimi_docs is unavailable in the standard scenario — present but disabled.
    const kimiDocs = within(dialog).getByRole('button', { name: /kimi_docs/ })
    expect(kimiDocs).toBeDisabled()
    expect(kimiDocs).toHaveTextContent('不可派发')
  })

  it('keeps an unavailable longer name from resolving to a ready shorter target', async () => {
    const snapshot = createStandardScenario()
    snapshot.agents.find((agent) => agent.name === 'cx_review')!.name = 'data'
    snapshot.agents.find((agent) => agent.name === 'kimi_docs')!.name =
      'data review'
    const port = new SnapshotRecordingPort(snapshot)
    const user = userEvent.setup()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const dialog = await openPicker(user)

    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'ask @@{{data review}'
    )

    const chips = within(dialog).getAllByRole('listitem', {
      name: /已选目标/
    })
    // Assert on the label text node: the decorative ⚠ glyph (#69
    // triple-encoding) is an aria-hidden sibling and must not leak into
    // expectations.
    expect(
      chips.some(
        (chip) => within(chip).queryByText('data review（不可派发）') !== null
      )
    ).toBe(true)
    expect(chips.map((chip) => chip.textContent)).not.toContain('data')
    expect(dialog).toHaveTextContent('不可派发的目标：data review')
    expect(
      within(dialog).getByRole('button', { name: '确认派发' })
    ).toBeDisabled()
    expect(port.commands).toHaveLength(0)
  })

  it('does not treat @@ typed into the composer as a multi-target dispatch', async () => {
    const { user, port } = await gotoAgentsSurface()
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))
    // The Agent Tab composer addresses only the current instance; typing @@
    // there must NOT fan out to other agents — only send-agent-instruction.
    await user.type(
      within(view).getByRole('textbox', { name: /发送给 cc_data/ }),
      'notify @@cc_sql too'
    )
    await user.click(
      within(view).getByRole('button', { name: '发送给 cc_data' })
    )
    expect(
      port.commands.filter((c) => c.kind === 'confirm-dispatch')
    ).toHaveLength(0)
    expect(
      port.commands.filter((c) => c.kind === 'send-agent-instruction')
    ).toHaveLength(1)
  })

  it('renders @@ inside assistant/activity text as plain text with no dispatch', async () => {
    // The standard scenario ships an activity summary containing `@@cc_etl`
    // (an assistant-style reference). Rendering it on the Overview surface
    // must never produce a dispatch command — assistant text is not a
    // dispatch trigger (#6 AC2, P3-4).
    const user = userEvent.setup()
    const port = new RecordingPort()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    // #76: the app lands on 首页 — enter the project to reach its Overview,
    // which lists recent activity.
    await user.click(
      within(
        screen.getByRole('navigation', { name: '快捷切换' })
      ).getByRole('button', { name: '销售数据分析' })
    )
    const overview = await screen.findByRole('region', { name: '项目概览' })
    expect(overview).toHaveTextContent('@@cc_etl')
    expect(
      port.commands.filter((c) => c.kind === 'confirm-dispatch')
    ).toHaveLength(0)
    expect(
      port.commands.filter((c) => c.kind === 'send-agent-instruction')
    ).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 4 — idempotent confirm-dispatch
// ---------------------------------------------------------------------------

describe('Dispatch — idempotency', () => {
  it('submits only once while a confirmation response is pending', async () => {
    const user = userEvent.setup()
    const port = new DeferredCommandPort('confirm-dispatch')
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const dialog = await openPicker(user)

    await user.click(within(dialog).getByRole('button', { name: /cx_review/ }))
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'run once'
    )
    const confirm = within(dialog).getByRole('button', { name: '确认派发' })

    await user.click(confirm)
    await user.click(confirm)

    try {
      expect(
        port.commands.filter((command) => command.kind === 'confirm-dispatch')
      ).toHaveLength(1)
    } finally {
      await act(() => port.resolvePending())
    }
  })

  it('freezes the submitted target preview while confirmation is pending', async () => {
    const user = userEvent.setup()
    const port = new DeferredCommandPort('confirm-dispatch')
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const dialog = await openPicker(user)

    const submittedTarget = within(dialog).getByRole('button', {
      name: /cx_review/
    })
    const otherTarget = within(dialog).getByRole('button', { name: /cc_etl/ })
    await user.click(submittedTarget)
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'keep the submitted preview stable'
    )
    await user.click(
      within(dialog).getByRole('button', { name: '确认派发' })
    )

    try {
      expect(submittedTarget).toBeDisabled()
      expect(otherTarget).toBeDisabled()
      await user.click(otherTarget)
      const chips = within(dialog).getAllByRole('listitem', {
        name: /已选目标/
      })
      expect(chips.map((chip) => chip.textContent)).toEqual(['cx_review'])
      expect(
        port.commands.filter((command) => command.kind === 'confirm-dispatch')
      ).toHaveLength(1)
    } finally {
      await act(() => port.resolvePending())
    }
  })

  it('keeps the submitted preview immutable when a snapshot event precedes the response', async () => {
    const user = userEvent.setup()
    const port = new DeferredMutableSnapshotPort()
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const dialog = await openPicker(user)

    await user.click(within(dialog).getByRole('button', { name: /cx_review/ }))
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'use the confirmed target and scope'
    )
    await user.click(
      within(dialog).getByRole('button', { name: '确认派发' })
    )

    try {
      await act(() =>
        port.publish((next) => {
          const project = next.projects[0]
          project.resourceBindings = []
          const target = next.agents.find(
            (agent) => agent.name === 'cx_review'
          )!
          target.name = 'renamed_after_submit'
          target.queueDepth = 4
        })
      )

      const chips = within(dialog).getAllByRole('listitem', {
        name: /已选目标/
      })
      expect(chips.map((chip) => chip.textContent)).toEqual(['cx_review'])
      const preview = within(dialog).getByRole('region', {
        name: '派发预览'
      })
      expect(preview).toHaveTextContent('目标：cx_review')
      expect(preview).toHaveTextContent('销售团队任务清单')
      expect(preview).toHaveTextContent('cx_review: 无需排队')
      expect(preview).not.toHaveTextContent('renamed_after_submit')
      expect(preview).not.toHaveTextContent('已连接，但未绑定任何资源')
    } finally {
      await act(() => port.resolvePending())
    }
  })

  it('cannot dismiss and reopen the picker while confirmation is pending', async () => {
    const user = userEvent.setup()
    const port = new DeferredCommandPort('confirm-dispatch')
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const dialog = await openPicker(user)

    await user.click(within(dialog).getByRole('button', { name: /cx_review/ }))
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'keep one pending command'
    )
    await user.click(
      within(dialog).getByRole('button', { name: '确认派发' })
    )

    try {
      const cancel = within(dialog).getByRole('button', { name: '取消' })
      expect(cancel).toBeDisabled()
      await user.keyboard('{Escape}')
      await user.click(cancel)

      expect(
        screen.getByRole('dialog', { name: '派发给 Agent' })
      ).toBeInTheDocument()
      expect(
        port.commands.filter((command) => command.kind === 'confirm-dispatch')
      ).toHaveLength(1)
    } finally {
      await act(() => port.resolvePending())
    }

    expect(screen.queryByRole('dialog', { name: '派发给 Agent' })).toBeNull()
  })

  it('keeps the nested broadcast confirmation open while its response is pending', async () => {
    const snapshot = createStandardScenario()
    snapshot.agents.find((agent) => agent.name === 'kimi_docs')!.runtimeState =
      'ready'
    const user = userEvent.setup()
    const port = new DeferredCommandPort('confirm-dispatch', snapshot)
    render(<ProjectShell port={port} />)
    await screen.findByRole('button', { name: '概览' })
    const picker = await openPicker(user)

    await user.type(
      within(picker).getByRole('textbox', { name: '指令' }),
      '@@all keep broadcast pending'
    )
    await user.click(within(picker).getByRole('button', { name: '确认派发' }))
    const broadcast = await screen.findByRole('dialog', {
      name: '确认广播派发'
    })
    await user.click(
      within(broadcast).getByRole('button', { name: '确认广播' })
    )

    try {
      expect(
        within(broadcast).getByRole('button', { name: '取消' })
      ).toBeDisabled()
      await user.keyboard('{Escape}')
      expect(
        screen.getByRole('dialog', { name: '确认广播派发' })
      ).toBeInTheDocument()
      expect(
        port.commands.filter((command) => command.kind === 'confirm-dispatch')
      ).toHaveLength(1)
    } finally {
      await act(() => port.resolvePending())
    }

    expect(screen.queryByRole('dialog', { name: '派发给 Agent' })).toBeNull()
  })

  it('a duplicate confirm-dispatch with the same CommandId does not create a second dispatch set', async () => {
    const { user, port } = await gotoAgentsSurface()
    const dialog = await openPicker(user)

    await user.click(within(dialog).getByRole('button', { name: /cx_review/ }))
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'go'
    )
    await user.click(within(dialog).getByRole('button', { name: '确认派发' }))

    const confirms = port.commands.filter((c) => c.kind === 'confirm-dispatch')
    expect(confirms).toHaveLength(1)

    // Re-dispatching the exact same command (same CommandId) on the same
    // adapter returns the cached result and emits no further dispatch-created.
    const events: WorkbenchEvent[] = []
    const unsub = port.subscribe((e) => events.push(e))
    const dupResult = await port.dispatch(confirms[0])
    unsub()
    expect(dupResult.ok).toBe(true)
    expect(
      events.filter((e) => e.kind === 'dispatch-created')
    ).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 5 — no real side effects
// ---------------------------------------------------------------------------

describe('Dispatch — mock safety', () => {
  it('confirm-dispatch records dispatch-created events without spawning processes, PTY, Git or Feishu work', async () => {
    const api = installApiSpies()
    const adapter = new MockScenarioAdapter()
    const snapshot = await adapter.getSnapshot()
    const project = snapshot.projects[0]
    // Pick a dispatchable target (cx_review is ready in the standard scenario).
    const target = snapshot.agents.find(
      (a) =>
        a.projectId === project.projectId &&
        a.runtimeState !== 'unavailable' &&
        a.runtimeState !== 'archived'
    )!
    const events: WorkbenchEvent[] = []
    const unsub = adapter.subscribe((e) => events.push(e))

    const command: WorkbenchCommand = {
      commandId: id('cmd-dispatch-1', 'CommandId'),
      expectedRevision: snapshot.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [target.agentInstanceId],
      instruction: 'noop'
    }
    const result = await adapter.dispatch(command)
    unsub()

    expect(result.ok).toBe(true)
    const created = events.filter((e) => e.kind === 'dispatch-created')
    expect(created).toHaveLength(1)
    if (created[0].kind === 'dispatch-created') {
      expect(created[0].dispatchIds).toHaveLength(1)
    }

    // No runtime/permission/terminal events leak out of a pure dispatch.
    expect(events.some((e) => e.kind === 'permission-requested')).toBe(false)
    for (const capability of Object.values(api)) {
      expect(capability).not.toHaveBeenCalled()
    }
  })

  it('rejects a mixed target set atomically instead of partially dispatching', async () => {
    const adapter = new MockScenarioAdapter()
    const snapshot = await adapter.getSnapshot()
    const project = snapshot.projects[0]
    const dispatchable = snapshot.agents.find(
      (a) => a.projectId === project.projectId && a.name === 'cx_review'
    )!
    const unavailable = snapshot.agents.find(
      (a) => a.projectId === project.projectId && a.runtimeState === 'unavailable'
    )!

    const result = await adapter.dispatch({
      commandId: id('cmd-mixed', 'CommandId'),
      expectedRevision: snapshot.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [dispatchable.agentInstanceId, unavailable.agentInstanceId],
      instruction: 'mixed'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unavailable')
    }
  })

  it('keeps the Agent Picker within the active project only', async () => {
    const { user } = await gotoAgentsSurface()
    const dialog = await openPicker(user)

    // cc_report belongs to the other project and must not be selectable.
    expect(
      within(dialog).queryByRole('button', { name: /cc_report/ })
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2nd-round Codex review fixes — adapter contracts
// ---------------------------------------------------------------------------

describe('Dispatch — adapter target-set contracts (#6 review round 2)', () => {
  it('rejects an empty target set', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const project = snap.projects[0]
    const result = await adapter.dispatch({
      commandId: id('cmd-empty', 'CommandId'),
      expectedRevision: snap.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [],
      instruction: 'noop'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })

  it('rejects a duplicate target set', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const project = snap.projects[0]
    const target = snap.agents.find((a) => a.name === 'cx_review')!
    const result = await adapter.dispatch({
      commandId: id('cmd-dup', 'CommandId'),
      expectedRevision: snap.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [target.agentInstanceId, target.agentInstanceId],
      instruction: 'dup'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })

  it('rejects an empty instruction', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const project = snap.projects[0]
    const target = snap.agents.find((a) => a.name === 'cx_review')!
    const result = await adapter.dispatch({
      commandId: id('cmd-noinstr', 'CommandId'),
      expectedRevision: snap.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [target.agentInstanceId],
      instruction: '   '
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })

  it('advances the per-instance queue position after dispatching to a busy agent', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const project = snap.projects[0]
    // cc_data is running (busy) — dispatches must queue behind it.
    const ccData = snap.agents.find((a) => a.name === 'cc_data')!
    const before = (await adapter.getSnapshot()).agents.find(
      (a) => a.agentInstanceId === ccData.agentInstanceId
    )!.queueDepth

    await adapter.dispatch({
      commandId: id('cmd-q1', 'CommandId'),
      expectedRevision: snap.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [ccData.agentInstanceId],
      instruction: 'first'
    })
    const midSnap = await adapter.getSnapshot()
    const mid = midSnap.agents.find(
      (a) => a.agentInstanceId === ccData.agentInstanceId
    )!.queueDepth
    expect(mid).toBe(before + 1)
    // Queue projection must stay consistent across all views (#6 P1-2):
    // per-instance depth, the QueueItem list, Project summary and global
    // summary all advance together, not just queueDepth in isolation.
    const midProject = midSnap.projects[0]
    expect(midProject.queuedRunCount).toBe(snap.projects[0].queuedRunCount + 1)
    expect(midSnap.global.concurrency.queuedGlobal).toBe(
      snap.global.concurrency.queuedGlobal + 1
    )
    expect(
      midSnap.queue.filter((q) => q.agentInstanceId === ccData.agentInstanceId)
    ).toHaveLength(1)

    // A second dispatch to the same busy agent must advance the queue again,
    // so the next preview shows a progressing position (#6 P2-4).
    const snap2 = await adapter.getSnapshot()
    await adapter.dispatch({
      commandId: id('cmd-q2', 'CommandId'),
      expectedRevision: snap2.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [ccData.agentInstanceId],
      instruction: 'second'
    })
    const afterSnap = await adapter.getSnapshot()
    const after = afterSnap.agents.find(
      (a) => a.agentInstanceId === ccData.agentInstanceId
    )!.queueDepth
    expect(after).toBe(mid + 1)
    expect(afterSnap.projects[0].queuedRunCount).toBe(midProject.queuedRunCount + 1)
    expect(afterSnap.global.concurrency.queuedGlobal).toBe(
      midSnap.global.concurrency.queuedGlobal + 1
    )
  })

  it('composer start-or-queue to a busy agent enters the observable queue', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const ccData = snap.agents.find((a) => a.name === 'cc_data')!
    const beforeDepth = snap.agents.find(
      (a) => a.agentInstanceId === ccData.agentInstanceId
    )!.queueDepth
    const beforeQueuedGlobal = snap.global.concurrency.queuedGlobal

    await adapter.dispatch({
      commandId: id('cmd-comp', 'CommandId'),
      expectedRevision: snap.revision,
      kind: 'send-agent-instruction',
      projectId: ccData.projectId,
      agentInstanceId: ccData.agentInstanceId,
      instruction: 'from composer',
      mode: 'start-or-queue'
    })
    const after = await adapter.getSnapshot()
    const afterAgent = after.agents.find(
      (a) => a.agentInstanceId === ccData.agentInstanceId
    )!
    // The composer's queued instruction must land in the same queue state as
    // a dispatch — not be silently dropped (#6 P1-2).
    expect(afterAgent.queueDepth).toBe(beforeDepth + 1)
    expect(after.global.concurrency.queuedGlobal).toBe(beforeQueuedGlobal + 1)
    expect(
      after.queue.some((q) => q.agentInstanceId === ccData.agentInstanceId)
    ).toBe(true)
  })

  it('does not advance the queue for an idle agent', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const project = snap.projects[0]
    const idle = snap.agents.find((a) => a.name === 'cx_review')!
    await adapter.dispatch({
      commandId: id('cmd-idle', 'CommandId'),
      expectedRevision: snap.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [idle.agentInstanceId],
      instruction: 'go'
    })
    const after = (await adapter.getSnapshot()).agents.find(
      (a) => a.agentInstanceId === idle.agentInstanceId
    )!.queueDepth
    expect(after).toBe(0)
  })

  it('enqueues again for an already-queued agent (#6 P1-2)', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const project = snap.projects[0]
    // cx_forecast starts queued with queueDepth 2.
    const forecast = snap.agents.find((a) => a.name === 'cx_forecast')!
    const beforeDepth = forecast.queueDepth
    const beforeGlobal = snap.global.concurrency.queuedGlobal
    await adapter.dispatch({
      commandId: id('cmd-requeue', 'CommandId'),
      expectedRevision: snap.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [forecast.agentInstanceId],
      instruction: 'more work'
    })
    const after = await adapter.getSnapshot()
    const afterForecast = after.agents.find(
      (a) => a.agentInstanceId === forecast.agentInstanceId
    )!
    // An already-queued agent receiving more work must grow the queue, not
    // silently keep the same depth (#6 P1-2).
    expect(afterForecast.queueDepth).toBe(beforeDepth + 1)
    expect(after.global.concurrency.queuedGlobal).toBe(beforeGlobal + 1)
    expect(
      after.queue.filter((q) => q.agentInstanceId === forecast.agentInstanceId)
    ).toHaveLength(3)
  })

  it('accepts a dispatch during Terminal takeover and queues it behind the occupied execution slot', async () => {
    const adapter = new MockScenarioAdapter()
    const snapshot = await adapter.getSnapshot()
    const project = snapshot.projects[0]
    const terminalAgent = snapshot.agents.find(
      (agent) => agent.name === 'cx_anti'
    )!

    const result = await adapter.dispatch({
      commandId: id('cmd-terminal-queue', 'CommandId'),
      expectedRevision: snapshot.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [terminalAgent.agentInstanceId],
      instruction: 'run after Terminal closes'
    })

    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const queuedAgent = after.agents.find(
      (agent) => agent.agentInstanceId === terminalAgent.agentInstanceId
    )!
    expect(queuedAgent.queueDepth).toBe(terminalAgent.queueDepth + 1)
    expect(
      after.queue.some(
        (item) => item.agentInstanceId === terminalAgent.agentInstanceId
      )
    ).toBe(true)
  })

  it('treats Terminal opening as occupied: composer command is rejected while Dispatch is queued', async () => {
    const snapshot = createStandardScenario()
    const project = snapshot.projects[0]
    const terminalAgent = snapshot.agents.find(
      (agent) => agent.name === 'cx_anti'
    )!
    terminalAgent.terminalState = 'opening'
    const adapter = new MockScenarioAdapter(snapshot)

    const instructionResult = await adapter.dispatch({
      commandId: id('cmd-terminal-opening-instruction', 'CommandId'),
      expectedRevision: snapshot.revision,
      kind: 'send-agent-instruction',
      projectId: project.projectId,
      agentInstanceId: terminalAgent.agentInstanceId,
      instruction: 'must not race the PTY',
      mode: 'start-or-queue'
    })
    expect(instructionResult.ok).toBe(false)
    if (!instructionResult.ok) expect(instructionResult.reason).toBe('busy')

    const dispatchResult = await adapter.dispatch({
      commandId: id('cmd-terminal-opening-dispatch', 'CommandId'),
      expectedRevision: snapshot.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [terminalAgent.agentInstanceId],
      instruction: 'run after the PTY closes'
    })
    expect(dispatchResult.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(
      after.agents.find(
        (agent) => agent.agentInstanceId === terminalAgent.agentInstanceId
      )!.queueDepth
    ).toBe(terminalAgent.queueDepth + 1)
  })

  it('rejects composer and Dispatch commands atomically when the Project is archived', async () => {
    const snapshot = createStandardScenario()
    const project = snapshot.projects[0]
    project.lifecycle = 'archived'
    const target = snapshot.agents.find((agent) => agent.name === 'cx_review')!
    const adapter = new MockScenarioAdapter(snapshot)
    const before = await adapter.getSnapshot()

    const instructionResult = await adapter.dispatch({
      commandId: id('cmd-archived-instruction', 'CommandId'),
      expectedRevision: snapshot.revision,
      kind: 'send-agent-instruction',
      projectId: project.projectId,
      agentInstanceId: target.agentInstanceId,
      instruction: 'must not run',
      mode: 'start-or-queue'
    })
    const dispatchResult = await adapter.dispatch({
      commandId: id('cmd-archived-dispatch', 'CommandId'),
      expectedRevision: snapshot.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [target.agentInstanceId],
      instruction: 'must not dispatch'
    })

    expect(instructionResult.ok).toBe(false)
    expect(dispatchResult.ok).toBe(false)
    if (!instructionResult.ok) {
      expect(instructionResult.reason).toBe('unavailable')
    }
    if (!dispatchResult.ok) {
      expect(dispatchResult.reason).toBe('unavailable')
    }
    expect(await adapter.getSnapshot()).toEqual(before)
  })

  it('rejects composer and Dispatch commands atomically when the Project Root is unavailable', async () => {
    const snapshot = createStandardScenario()
    const project = snapshot.projects[0]
    project.rootAvailability = 'unavailable'
    const target = snapshot.agents.find((agent) => agent.name === 'cx_review')!
    const adapter = new MockScenarioAdapter(snapshot)
    const before = await adapter.getSnapshot()

    const instructionResult = await adapter.dispatch({
      commandId: id('cmd-root-unavailable-instruction', 'CommandId'),
      expectedRevision: snapshot.revision,
      kind: 'send-agent-instruction',
      projectId: project.projectId,
      agentInstanceId: target.agentInstanceId,
      instruction: 'must wait for the root',
      mode: 'start-or-queue'
    })
    const dispatchResult = await adapter.dispatch({
      commandId: id('cmd-root-unavailable-dispatch', 'CommandId'),
      expectedRevision: snapshot.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [target.agentInstanceId],
      instruction: 'must not dispatch without a root'
    })

    expect(instructionResult.ok).toBe(false)
    expect(dispatchResult.ok).toBe(false)
    if (!instructionResult.ok) {
      expect(instructionResult.reason).toBe('unavailable')
    }
    if (!dispatchResult.ok) {
      expect(dispatchResult.reason).toBe('unavailable')
    }
    expect(await adapter.getSnapshot()).toEqual(before)
  })

  it('rejects composer and Dispatch commands atomically when the Project repository is not ready', async () => {
    const snapshot = createStandardScenario()
    const project = snapshot.projects[0]
    project.repositoryReadiness = 'not-ready'
    const target = snapshot.agents.find((agent) => agent.name === 'cx_review')!
    const adapter = new MockScenarioAdapter(snapshot)
    const before = await adapter.getSnapshot()

    const instructionResult = await adapter.dispatch({
      commandId: id('cmd-repository-not-ready-instruction', 'CommandId'),
      expectedRevision: snapshot.revision,
      kind: 'send-agent-instruction',
      projectId: project.projectId,
      agentInstanceId: target.agentInstanceId,
      instruction: 'must wait for a Git repository',
      mode: 'start-or-queue'
    })
    const dispatchResult = await adapter.dispatch({
      commandId: id('cmd-repository-not-ready-dispatch', 'CommandId'),
      expectedRevision: snapshot.revision,
      kind: 'confirm-dispatch',
      projectId: project.projectId,
      targets: [target.agentInstanceId],
      instruction: 'must not dispatch without a Git repository'
    })

    expect(instructionResult.ok).toBe(false)
    expect(dispatchResult.ok).toBe(false)
    if (!instructionResult.ok) {
      expect(instructionResult.reason).toBe('unavailable')
    }
    if (!dispatchResult.ok) {
      expect(dispatchResult.reason).toBe('unavailable')
    }
    expect(await adapter.getSnapshot()).toEqual(before)
  })
})

describe('Dispatch — Agent Name syntax contracts (#6 review round 2)', () => {
  it('create-agent accepts names with spaces, punctuation, and the routing token text "all"', async () => {
    const { user, port } = await gotoAgentsSurface()
    // CONTEXT.md mandates only project-unique, case-insensitive names — no
    // ASCII-only restriction. Names like "data review" or "name!" must be
    // accepted so the create-agent contract is not narrowed (#6 P2-3).
    const accepted = ['data review', 'name!', 'all']
    for (const name of accepted) {
      await user.click(screen.getByRole('button', { name: '新建 Agent' }))
      await user.type(
        await screen.findByRole('textbox', { name: 'Agent 名称' }),
        name
      )
      await user.click(screen.getByRole('button', { name: '创建 Agent' }))
      // No alert → accepted.
      expect(screen.queryByRole('alert')).toBeNull()
    }
    expect(
      port.commands.filter((c) => c.kind === 'create-agent').length
    ).toBeGreaterThanOrEqual(accepted.length)
  })

  it('keeps @@all as broadcast syntax even when an Agent is named "all"', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(screen.getByRole('button', { name: '新建 Agent' }))
    await user.type(
      await screen.findByRole('textbox', { name: 'Agent 名称' }),
      'all'
    )
    await user.click(screen.getByRole('button', { name: '创建 Agent' }))
    expect(screen.queryByRole('alert')).toBeNull()

    const dialog = await openPicker(user)
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      '@@all review the project'
    )
    expect(dialog).toHaveTextContent('@@all 已展开')
    expect(
      within(dialog).getAllByRole('listitem', { name: /已选目标/ })
    ).toHaveLength(9)
  })
})
