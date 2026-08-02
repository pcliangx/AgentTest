// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
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
import { ProjectShell } from './project-shell'

afterEach(() => cleanup())

/**
 * Wraps a MockScenarioAdapter and records every dispatched command, so tests
 * can assert that the renderer sent the expected typed Command (and only that).
 * The wrapper still serves the real scenario snapshots so navigation works.
 */
class RecordingPort implements WorkbenchPort {
  private readonly inner: MockScenarioAdapter
  readonly commands: WorkbenchCommand[] = []

  constructor() {
    this.inner = new MockScenarioAdapter()
  }

  async getSnapshot(): Promise<WorkbenchViewModel> {
    return this.inner.getSnapshot()
  }

  async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    this.commands.push(command)
    return this.inner.dispatch(command)
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }
}

/**
 * Keeps confirm-dispatch responses pending after the real adapter has accepted
 * them. This models the WorkbenchPort contract's allowed event-before-response
 * ordering and makes duplicate user confirmation deterministic.
 */
class DeferredConfirmPort implements WorkbenchPort {
  private readonly inner = new MockScenarioAdapter()
  private readonly pending: Array<{
    result: Promise<CommandResult>
    resolve: (result: CommandResult) => void
  }> = []
  readonly commands: WorkbenchCommand[] = []

  getSnapshot(): Promise<WorkbenchViewModel> {
    return this.inner.getSnapshot()
  }

  dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    this.commands.push(command)
    const result = this.inner.dispatch(command)
    if (command.kind !== 'confirm-dispatch') return result
    return new Promise((resolve) => {
      this.pending.push({ result, resolve })
    })
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }

  async resolveConfirmations(): Promise<void> {
    const pending = this.pending.splice(0)
    const results = await Promise.all(pending.map((item) => item.result))
    pending.forEach((item, index) => item.resolve(results[index]))
    await Promise.resolve()
  }
}

/** Renders the shell, navigates to the Agents surface and returns helpers. */
async function gotoAgentsSurface() {
  const user = userEvent.setup()
  const port = new RecordingPort()
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
  it('sends an instruction addressed only to the currently open AgentInstanceId', async () => {
    const { user, port } = await gotoAgentsSurface()
    // cc_data is open and active by default in the standard scenario.
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))

    const composer = within(view).getByRole('textbox', {
      name: /发送给当前 Agent/
    })
    await user.type(composer, 'clean the Q2 pipeline')
    await user.click(
      within(view).getByRole('button', { name: '发送给当前 Agent' })
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
      within(view).getByRole('textbox', { name: /发送给当前 Agent/ }),
      'follow up'
    )
    await user.click(
      within(view).getByRole('button', { name: '发送给当前 Agent' })
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
    await user.click(within(directory).getByRole('button', { name: /cc_sql/ }))
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))
    await user.type(
      within(view).getByRole('textbox', { name: /发送给当前 Agent/ }),
      'here is the input'
    )
    await user.click(
      within(view).getByRole('button', { name: '发送给当前 Agent' })
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
    await user.click(within(directory).getByRole('button', { name: /cx_anti/ }))
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))
    // Composer must be disabled and explain the Terminal mutex.
    expect(view).toHaveTextContent('Terminal 接管中')
    expect(
      within(view).getByRole('textbox', { name: /发送给当前 Agent/ })
    ).toBeDisabled()
    expect(
      port.commands.filter((c) => c.kind === 'send-agent-instruction')
    ).toHaveLength(0)
  })

  it('addresses an idle agent as start-or-queue', async () => {
    const { user, port, ...rest } = await gotoAgentsSurface()
    void rest
    // cx_review is ready (idle) in the standard scenario — open it first.
    const directory = screen.getByRole('region', { name: 'Agent 目录' })
    await user.click(within(directory).getByRole('button', { name: /cx_review/ }))
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))
    await user.type(
      within(view).getByRole('textbox', { name: /发送给当前 Agent/ }),
      'kick off'
    )
    await user.click(
      within(view).getByRole('button', { name: '发送给当前 Agent' })
    )
    const sent = port.commands.find(
      (c) => c.kind === 'send-agent-instruction'
    )!
    expect(sent).toMatchObject({
      agentInstanceId: id('inst-cx-review', 'AgentInstanceId'),
      mode: 'start-or-queue'
    })
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 2 — Agent Picker, chips, @@ parsing
// ---------------------------------------------------------------------------

describe('Dispatch — Agent Picker and @@ routing', () => {
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

  it('parses @@<agent-name> in the instruction into visible chips before confirming', async () => {
    const { user, port } = await gotoAgentsSurface()
    const dialog = await openPicker(user)

    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'cc_sql please review @@cx_review and @@kimi_visual'
    )

    // @@ references resolve to chips for the named instances.
    const parsed = within(dialog).getAllByRole('listitem', {
      name: /已选目标/
    })
    expect(parsed.some((c) => c.textContent?.includes('cx_review'))).toBe(true)
    expect(parsed.some((c) => c.textContent?.includes('kimi_visual'))).toBe(true)
  })

  it('does not misread @@all-review (a valid agent name) as an @@all broadcast', async () => {
    const { user } = await gotoAgentsSurface()
    const dialog = await openPicker(user)
    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'ping @@all-review'
    )
    // No broadcast expansion banner should appear.
    expect(dialog).not.toHaveTextContent('展开为全部实例')
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

    expect(dialog).toHaveTextContent('已展开为全部可派发实例')
    expect(
      within(dialog).getAllByRole('listitem', { name: /已选目标/ })
    ).toHaveLength(7)

    await user.click(within(dialog).getByRole('button', { name: '确认派发' }))
    expect(
      await screen.findByRole('dialog', { name: /确认广播/ })
    ).toBeInTheDocument()
  })

  it('expands @@all into the current Project dispatchable instances and requires a second confirmation', async () => {
    const { user, port } = await gotoAgentsSurface()
    const dialog = await openPicker(user)

    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'stand up @@all'
    )

    // @@all surfaces the explicit instance list for the active project before
    // any dispatch happens.
    expect(dialog).toHaveTextContent('已展开为全部可派发实例')

    // The standard sales project has 8 instances; kimi_docs is unavailable
    // and cx_anti holds a Terminal takeover, so only 6 are dispatchable.
    // Terminal-active targets must be excluded so the broadcast can actually
    // succeed instead of being rejected by the adapter (#6 P1-1).
    const expansion = within(dialog).getAllByRole('listitem', {
      name: /已选目标/
    })
    expect(expansion.length).toBe(6)
    expect(
      expansion.some((c) => c.textContent?.includes('kimi_docs'))
    ).toBe(false)
    expect(
      expansion.some((c) => c.textContent?.includes('cx_anti'))
    ).toBe(false)

    // Confirm once → must still ask for explicit confirmation of the broadcast.
    await user.click(within(dialog).getByRole('button', { name: '确认派发' }))
    const broadcastDialog = await screen.findByRole('dialog', {
      name: /确认广播/
    })

    // Before the explicit broadcast confirmation, no dispatch command exists.
    expect(
      port.commands.filter((c) => c.kind === 'confirm-dispatch').length
    ).toBe(0)

    // Complete the second confirmation — the broadcast must actually succeed
    // (one dispatch per dispatchable target), proving @@all no longer
    // dead-ends on the excluded Terminal-active instance (#6 P1-1).
    await user.click(
      within(broadcastDialog).getByRole('button', { name: '确认广播' })
    )
    const confirms = port.commands.filter((c) => c.kind === 'confirm-dispatch')
    expect(confirms).toHaveLength(1)
    expect(confirms[0].targets).toHaveLength(6)
  })

  it('excludes unavailable agents from the selectable list', async () => {
    const { user } = await gotoAgentsSurface()
    const dialog = await openPicker(user)
    // kimi_docs is unavailable in the standard scenario — present but disabled.
    const kimiDocs = within(dialog).getByRole('button', { name: /kimi_docs/ })
    expect(kimiDocs).toBeDisabled()
    expect(kimiDocs).toHaveTextContent('不可派发')
  })

  it('does not treat @@ typed into the composer as a multi-target dispatch', async () => {
    const { user, port } = await gotoAgentsSurface()
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))
    // The Agent Tab composer addresses only the current instance; typing @@
    // there must NOT fan out to other agents — only send-agent-instruction.
    await user.type(
      within(view).getByRole('textbox', { name: /发送给当前 Agent/ }),
      'notify @@cc_sql too'
    )
    await user.click(
      within(view).getByRole('button', { name: '发送给当前 Agent' })
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
    // Overview is the default landing surface; it lists recent activity.
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
    const port = new DeferredConfirmPort()
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
      await act(() => port.resolveConfirmations())
    }
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
    // cx_forecast starts queued with queueDepth 1.
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
    ).toHaveLength(2)
  })
})

describe('Dispatch — Agent Name syntax contracts (#6 review round 2)', () => {
  it('create-agent accepts names with spaces or punctuation (only "all" is reserved)', async () => {
    const { user, port } = await gotoAgentsSurface()
    // CONTEXT.md mandates only project-unique, case-insensitive names — no
    // ASCII-only restriction. Names like "data review" or "name!" must be
    // accepted so the create-agent contract is not narrowed (#6 P2-3).
    const accepted = ['data review', 'name!']
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

  it('create-agent rejects only the reserved broadcast word "all"', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(screen.getByRole('button', { name: '新建 Agent' }))
    await user.type(
      await screen.findByRole('textbox', { name: 'Agent 名称' }),
      'all'
    )
    await user.click(screen.getByRole('button', { name: '创建 Agent' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/保留词/)
  })
})
