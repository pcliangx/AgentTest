// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
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
})

// ---------------------------------------------------------------------------
// Acceptance criterion 2 — Agent Picker, chips, @@ parsing
// ---------------------------------------------------------------------------

describe('Dispatch — Agent Picker and @@ routing', () => {
  it('opens the Agent Picker, selects multiple targets shown as chips, previews, and confirms creating one dispatch per target', async () => {
    const { user, port } = await gotoAgentsSurface()
    await user.click(screen.getByRole('button', { name: '派发给 Agent' }))

    const dialog = await screen.findByRole('dialog', { name: '派发给 Agent' })

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
    await user.click(screen.getByRole('button', { name: '派发给 Agent' }))
    const dialog = await screen.findByRole('dialog', { name: '派发给 Agent' })

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

  it('parses @@<agent-name> in the instruction into visible chips before confirming', async () => {
    const { user, port } = await gotoAgentsSurface()
    await user.click(screen.getByRole('button', { name: '派发给 Agent' }))
    const dialog = await screen.findByRole('dialog', { name: '派发给 Agent' })

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

  it('expands @@all into the current Project instances and requires a second confirmation', async () => {
    const { user, port } = await gotoAgentsSurface()
    await user.click(screen.getByRole('button', { name: '派发给 Agent' }))
    const dialog = await screen.findByRole('dialog', { name: '派发给 Agent' })

    await user.type(
      within(dialog).getByRole('textbox', { name: '指令' }),
      'stand up @@all'
    )

    // @@all surfaces the explicit instance list for the active project before
    // any dispatch happens.
    expect(dialog).toHaveTextContent('展开为全部实例')

    // The standard sales project has 8 instances.
    const expansion = within(dialog).getAllByRole('listitem', {
      name: /已选目标/
    })
    expect(expansion.length).toBeGreaterThanOrEqual(8)

    // Confirm once → must still ask for explicit confirmation of the broadcast.
    await user.click(within(dialog).getByRole('button', { name: '确认派发' }))
    expect(
      await screen.findByRole('dialog', { name: /确认广播/ })
    ).toBeInTheDocument()

    // Awaiting the explicit broadcast confirmation is what actually dispatches.
    const beforeCount = port.commands.filter(
      (c) => c.kind === 'confirm-dispatch'
    ).length
    expect(beforeCount).toBe(0)
  })

  it('does not treat @@ appearing inside assistant text as a command trigger', async () => {
    const { user, port } = await gotoAgentsSurface()
    const view = await screen.findByRole('region', { name: 'Agent 视图' })
    await user.click(within(view).getByRole('button', { name: '对话' }))

    // Assistant conversation content containing @@ is rendered as plain text
    // and produces no dispatch command.
    expect(view).toHaveTextContent('@@cc_sql')
    expect(
      port.commands.filter((c) => c.kind === 'confirm-dispatch')
    ).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 4 — idempotent confirm-dispatch
// ---------------------------------------------------------------------------

describe('Dispatch — idempotency', () => {
  it('a duplicate confirm-dispatch with the same CommandId does not create a second dispatch set', async () => {
    const { user, port } = await gotoAgentsSurface()
    await user.click(screen.getByRole('button', { name: '派发给 Agent' }))
    const dialog = await screen.findByRole('dialog', { name: '派发给 Agent' })

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
    const target = snapshot.agents.find(
      (a) => a.projectId === project.projectId
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

  it('keeps the Agent Picker within the active project only', async () => {
    const { user } = await gotoAgentsSurface()
    await user.click(screen.getByRole('button', { name: '派发给 Agent' }))
    const dialog = await screen.findByRole('dialog', { name: '派发给 Agent' })

    // cc_report belongs to the other project and must not be selectable.
    expect(
      within(dialog).queryByRole('button', { name: /cc_report/ })
    ).toBeNull()
  })
})
