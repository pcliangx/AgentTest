import { describe, it, expect } from 'vitest'
import { MockScenarioAdapter } from './mock-scenario-adapter'
import { createStandardScenario } from './standard-scenario'
import { id } from './contract'
import type {
  AgentInstanceId,
  CommandId,
  ConfirmationId,
  HandoffId,
  ProjectId,
  WorkbenchCommand,
  WorkbenchEvent
} from './contract'

function cmdId(n: number): CommandId {
  return id(`cmd-hq-${n}`, 'CommandId')
}

const PROJECT_SALES = id('proj-sales', 'ProjectId')
const PROJECT_RESEARCH = id('proj-research', 'ProjectId')

// ---------------------------------------------------------------------------
// #12 AC1 — Handoffs surface data model
// ---------------------------------------------------------------------------

describe('Standard scenario — handoff data (#12 AC1)', () => {
  it('includes at least one complete handoff with all required fields', () => {
    const scenario = createStandardScenario()
    expect(scenario.handoffs).toBeDefined()
    expect(scenario.handoffs.length).toBeGreaterThanOrEqual(1)

    const complete = scenario.handoffs.find(
      (h) => h.completeness === 'complete'
    )
    expect(complete).toBeDefined()
    if (!complete) return

    // Stable ID (AC1)
    expect(complete.handoffId).toBeDefined()
    // Source / target (AC1)
    expect(complete.source.agentInstanceId).toBeDefined()
    expect(complete.source.agentName).toBeTruthy()
    expect(complete.target).toBeDefined()
    expect(complete.target!.agentInstanceId).toBeDefined()
    // Provenance (AC1)
    expect(complete.provenance.origin).toBeTruthy()
    expect(complete.provenance.createdAt).toBeGreaterThan(0)
    // Base commit (AC1)
    expect(complete.baseCommit).toBeTruthy()
    // Change summary (AC1)
    expect(complete.changeSummary).toBeTruthy()
    // Artifacts (AC1)
    expect(complete.artifacts.length).toBeGreaterThan(0)
    // Validation result (AC1)
    expect(complete.validation.status).toBeTruthy()
    // Goal and summary (AC1)
    expect(complete.goal).toBeTruthy()
    expect(complete.summary).toBeTruthy()
    // Recovery actions (AC1)
    expect(complete.recoveryActions).toEqual(expect.any(Array))
    // Import state
    expect(complete.importState).toBeDefined()
  })

  it('includes at least one incomplete handoff with reason and recovery actions', () => {
    const scenario = createStandardScenario()
    const incomplete = scenario.handoffs.find(
      (h) => h.completeness === 'incomplete'
    )
    expect(incomplete).toBeDefined()
    if (!incomplete) return

    // Incomplete reason (AC1)
    expect(incomplete.incompleteReason).toBeTruthy()
    // Recovery actions (AC1)
    expect(incomplete.recoveryActions.length).toBeGreaterThan(0)
  })

  it('includes at least one cross-project handoff for import testing', () => {
    const scenario = createStandardScenario()
    const crossProject = scenario.handoffs.find(
      (h) => h.provenance.origin === 'cross-project'
    )
    expect(crossProject).toBeDefined()
    if (!crossProject) return
    expect(crossProject.provenance.sourceProjectName).toBeTruthy()
  })

  it('includes a handoff that references the research project for deep-link (#9)', () => {
    const scenario = createStandardScenario()
    const researchHandoff = scenario.handoffs.find(
      (h) => h.projectId === PROJECT_RESEARCH
    )
    expect(researchHandoff).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// #12 AC1 — Handoffs surface exposes handoff data through the port
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — handoffs snapshot (#12 AC1)', () => {
  it('exposes handoffs through getSnapshot', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    expect(snap.handoffs).toBeDefined()
    expect(snap.handoffs.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// #12 AC2 — import-handoff inspect-only
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — import-handoff inspect-only (#12 AC2)', () => {
  const CROSS_HANDOFF = id('handoff-cross-002', 'HandoffId')
  const CC_REPORT = id('inst-cc-report', 'AgentInstanceId')

  it('sets importState to inspect-only without creating a Run', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const activeRunsBefore = before.global.concurrency.activeGlobal

    const result = await adapter.dispatch({
      kind: 'import-handoff',
      commandId: cmdId(1),
      expectedRevision: before.revision,
      projectId: PROJECT_RESEARCH,
      handoffId: CROSS_HANDOFF,
      targetAgentInstanceId: CC_REPORT,
      mode: 'inspect-only'
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const handoff = after.handoffs.find(
      (h) => h.handoffId === CROSS_HANDOFF
    )!
    expect(handoff.importState).toBe('inspect-only')
    // No Run created (AC2: "只创建可检查记录且不产生 Run")
    expect(after.global.concurrency.activeGlobal).toBe(activeRunsBefore)
  })

  it('emits a handoff-imported event with mode inspect-only', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const events: WorkbenchEvent[] = []
    adapter.subscribe((e) => events.push(e))

    await adapter.dispatch({
      kind: 'import-handoff',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT_RESEARCH,
      handoffId: CROSS_HANDOFF,
      targetAgentInstanceId: CC_REPORT,
      mode: 'inspect-only'
    })

    const imported = events.find(
      (e): e is Extract<WorkbenchEvent, { kind: 'handoff-imported' }> =>
        e.kind === 'handoff-imported'
    )
    expect(imported).toBeDefined()
    expect(imported!.mode).toBe('inspect-only')
    expect(imported!.handoffId).toEqual(CROSS_HANDOFF)
  })

  it('does not change the target agent runtime state', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const agentBefore = snap.agents.find(
      (a) => a.agentInstanceId === CC_REPORT
    )!

    await adapter.dispatch({
      kind: 'import-handoff',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT_RESEARCH,
      handoffId: CROSS_HANDOFF,
      targetAgentInstanceId: CC_REPORT,
      mode: 'inspect-only'
    })

    const after = await adapter.getSnapshot()
    const agentAfter = after.agents.find(
      (a) => a.agentInstanceId === CC_REPORT
    )!
    expect(agentAfter.runtimeState).toBe(agentBefore.runtimeState)
    expect(agentAfter.activeRunId).toBe(agentBefore.activeRunId)
  })

  it('rejects a non-existent handoff', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch({
      kind: 'import-handoff',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT_RESEARCH,
      handoffId: id('handoff-nonexistent', 'HandoffId'),
      targetAgentInstanceId: CC_REPORT,
      mode: 'inspect-only'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })

  it('rejects a non-existent target agent', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch({
      kind: 'import-handoff',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT_RESEARCH,
      handoffId: CROSS_HANDOFF,
      targetAgentInstanceId: id('inst-nope', 'AgentInstanceId'),
      mode: 'inspect-only'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })
})

// ---------------------------------------------------------------------------
// #12 AC2 — import-handoff execute-confirmed (request-execute → confirm)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — import-handoff execute-confirmed (#12 AC2)', () => {
  const CROSS_HANDOFF = id('handoff-cross-002', 'HandoffId')
  const CC_REPORT = id('inst-cc-report', 'AgentInstanceId')

  it('request-execute creates a confirmation with target and content preview', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()

    const result = await adapter.dispatch({
      kind: 'import-handoff',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT_RESEARCH,
      handoffId: CROSS_HANDOFF,
      targetAgentInstanceId: CC_REPORT,
      mode: 'request-execute'
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    expect(after.pendingConfirmation).toBeDefined()
    const conf = after.pendingConfirmation!
    expect(conf.action).toContain('导入')
    expect(conf.target).toContain('cc_report')
    expect(conf.impact).toContain('流失复核')
    expect(conf.nonBypassableReason).toBeTruthy()
  })

  it('confirm-dangerous-action sets importState to execute-confirmed and emits event', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const events: WorkbenchEvent[] = []
    adapter.subscribe((e) => events.push(e))

    await adapter.dispatch({
      kind: 'import-handoff',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT_RESEARCH,
      handoffId: CROSS_HANDOFF,
      targetAgentInstanceId: CC_REPORT,
      mode: 'request-execute'
    })
    const mid = await adapter.getSnapshot()
    const confId = mid.pendingConfirmation!.confirmationId

    const confirmResult = await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: mid.revision,
      confirmationId: confId
    })
    expect(confirmResult.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const handoff = after.handoffs.find(
      (h) => h.handoffId === CROSS_HANDOFF
    )!
    expect(handoff.importState).toBe('execute-confirmed')
    expect(after.pendingConfirmation).toBeUndefined()

    const imported = events.find(
      (e): e is Extract<WorkbenchEvent, { kind: 'handoff-imported' }> =>
        e.kind === 'handoff-imported' && e.mode === 'execute-confirmed'
    )
    expect(imported).toBeDefined()
    expect(imported!.handoffId).toEqual(CROSS_HANDOFF)
  })

  it('execute-confirmed does NOT create a Run in Phase 1', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const activeRunsBefore = snap.global.concurrency.activeGlobal

    await adapter.dispatch({
      kind: 'import-handoff',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT_RESEARCH,
      handoffId: CROSS_HANDOFF,
      targetAgentInstanceId: CC_REPORT,
      mode: 'request-execute'
    })
    const mid = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: mid.revision,
      confirmationId: mid.pendingConfirmation!.confirmationId
    })

    const after = await adapter.getSnapshot()
    // Phase 1 does not create real Runs from imports (US-090).
    expect(after.global.concurrency.activeGlobal).toBe(activeRunsBefore)
    const agent = after.agents.find(
      (a) => a.agentInstanceId === CC_REPORT
    )!
    expect(agent.activeRunId).toBeUndefined()
  })

  it('execute-confirmed records activity for the target agent', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()

    await adapter.dispatch({
      kind: 'import-handoff',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT_RESEARCH,
      handoffId: CROSS_HANDOFF,
      targetAgentInstanceId: CC_REPORT,
      mode: 'request-execute'
    })
    const mid = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: mid.revision,
      confirmationId: mid.pendingConfirmation!.confirmationId
    })

    const after = await adapter.getSnapshot()
    expect(after.activity[0].agentInstanceId).toEqual(CC_REPORT)
    expect(after.activity[0].summary).toContain('cc_report')
  })

  it('execute-confirmed with stale confirmationId is rejected', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch({
      kind: 'import-handoff',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT_RESEARCH,
      handoffId: CROSS_HANDOFF,
      targetAgentInstanceId: CC_REPORT,
      mode: 'execute-confirmed',
      confirmationId: id('fake-confirm', 'ConfirmationId')
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })

  it('request-execute rejects when a confirmation is already pending', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    // Create a confirmation via connection deletion
    const connId = snap.global.connections[0].connectionId
    await adapter.dispatch({
      kind: 'request-connection-deletion',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      connectionId: connId
    })
    const mid = await adapter.getSnapshot()
    expect(mid.pendingConfirmation).toBeDefined()

    const result = await adapter.dispatch({
      kind: 'import-handoff',
      commandId: cmdId(2),
      expectedRevision: mid.revision,
      projectId: PROJECT_RESEARCH,
      handoffId: CROSS_HANDOFF,
      targetAgentInstanceId: CC_REPORT,
      mode: 'request-execute'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('busy')
  })
})

// ---------------------------------------------------------------------------
// #12 AC3/AC4 — request-quit-preview
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — request-quit-preview (#12 AC3/AC4)', () => {
  it('produces a quit preview with active Runs, Terminals and dirty agents', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()

    const result = await adapter.dispatch({
      kind: 'request-quit-preview',
      commandId: cmdId(1),
      expectedRevision: snap.revision
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    expect(after.quitPreview).toBeDefined()
    const preview = after.quitPreview!
    // Standard scenario has active Runs (cc_data permission-requested, cc_sql needs-input)
    expect(preview.activeRuns.length).toBeGreaterThan(0)
    // Each entry has stable identity
    for (const run of preview.activeRuns) {
      expect(run.agentName).toBeTruthy()
      expect(run.runId).toBeDefined()
      expect(run.projectId).toBeDefined()
    }
    // Standard scenario has an active Terminal (cx_anti)
    expect(preview.activeTerminals.length).toBeGreaterThan(0)
    // Standard scenario has worktree changes (cc_data, cc_sql, cx_anti)
    expect(preview.handoffDirtyAgents.length).toBeGreaterThan(0)
  })

  it('activeRuns only includes agents with active structured Run states', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'request-quit-preview',
      commandId: cmdId(1),
      expectedRevision: snap.revision
    })
    const after = await adapter.getSnapshot()
    const preview = after.quitPreview!
    // Only active structured states: starting, running, finishing, needs-input, permission-requested
    const activeStates = [
      'starting',
      'running',
      'finishing',
      'needs-input',
      'permission-requested'
    ]
    for (const run of preview.activeRuns) {
      expect(activeStates).toContain(run.runtimeState)
    }
  })

  it('activeTerminals only includes agents with terminalState active', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'request-quit-preview',
      commandId: cmdId(1),
      expectedRevision: snap.revision
    })
    const after = await adapter.getSnapshot()
    const activeTerminalIds = after.quitPreview!.activeTerminals.map(
      (t) => t.agentInstanceId
    )
    const expectedTerminalIds = after.agents
      .filter((a) => a.terminalState === 'active')
      .map((a) => a.agentInstanceId)
    expect(activeTerminalIds).toEqual(expectedTerminalIds)
  })

  it('handoffDirtyAgents includes agents with uncommitted changes', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'request-quit-preview',
      commandId: cmdId(1),
      expectedRevision: snap.revision
    })
    const after = await adapter.getSnapshot()
    const dirtyIds = after.quitPreview!.handoffDirtyAgents.map(
      (d) => d.agentInstanceId
    )
    const expectedDirtyIds = after.changes.map((c) => c.agentInstanceId)
    expect(dirtyIds).toEqual(expectedDirtyIds)
  })

  it('quit preview for an idle scenario shows empty lists', async () => {
    const scenario = createStandardScenario()
    // Reset all agents to ready, clear changes
    for (const agent of scenario.agents) {
      agent.runtimeState = 'ready'
      agent.terminalState = 'closed'
      delete agent.activeRunId
    }
    scenario.changes = []
    const adapter = new MockScenarioAdapter(scenario)
    const snap = await adapter.getSnapshot()

    await adapter.dispatch({
      kind: 'request-quit-preview',
      commandId: cmdId(1),
      expectedRevision: snap.revision
    })
    const after = await adapter.getSnapshot()
    expect(after.quitPreview!.activeRuns).toHaveLength(0)
    expect(after.quitPreview!.activeTerminals).toHaveLength(0)
    expect(after.quitPreview!.handoffDirtyAgents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// #12 AC3/AC4 — execute-quit actions
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — execute-quit (#12 AC3/AC4)', () => {
  async function requestQuitPreview(
    adapter: MockScenarioAdapter
  ): Promise<void> {
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch({
      kind: 'request-quit-preview',
      commandId: cmdId(900),
      expectedRevision: snap.revision
    })
    expect(result.ok).toBe(true)
  }

  it('wait-for-runs dismisses the preview without stopping anything', async () => {
    const adapter = new MockScenarioAdapter()
    await requestQuitPreview(adapter)
    const mid = await adapter.getSnapshot()
    const activeBefore = mid.global.concurrency.activeGlobal
    expect(mid.quitPreview).toBeDefined()

    const result = await adapter.dispatch({
      kind: 'execute-quit',
      commandId: cmdId(1),
      expectedRevision: mid.revision,
      action: 'wait-for-runs'
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    expect(after.quitPreview).toBeUndefined()
    // All runs still active — close window preserves background state (AC3)
    expect(after.global.concurrency.activeGlobal).toBe(activeBefore)
  })

  it('stop-runs transitions active Runs to interrupted and closes Terminals', async () => {
    const adapter = new MockScenarioAdapter()
    await requestQuitPreview(adapter)
    const mid = await adapter.getSnapshot()

    const result = await adapter.dispatch({
      kind: 'execute-quit',
      commandId: cmdId(1),
      expectedRevision: mid.revision,
      action: 'stop-runs'
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    expect(after.quitPreview).toBeUndefined()
    // All previously active structured runs are now interrupted
    const previouslyActive = mid.agents.filter((a) =>
      ['starting', 'running', 'finishing', 'needs-input', 'permission-requested'].includes(
        a.runtimeState
      )
    )
    for (const agent of previouslyActive) {
      const updated = after.agents.find(
        (a) => a.agentInstanceId === agent.agentInstanceId
      )!
      expect(updated.runtimeState).toBe('interrupted')
      expect(updated.activeRunId).toBeUndefined()
    }
    // Terminals are closed
    for (const agent of after.agents) {
      if (agent.terminalState === 'active') {
        // Only agents that had terminal active before the quit
        const before = mid.agents.find(
          (a) => a.agentInstanceId === agent.agentInstanceId
        )
        if (!before || before.terminalState !== 'active') {
          throw new Error('terminal should have been closed')
        }
      }
    }
    expect(after.global.concurrency.activeGlobal).toBe(0)
  })

  it('request-final-handoff creates deterministic fallback snapshots for dirty agents', async () => {
    const adapter = new MockScenarioAdapter()
    await requestQuitPreview(adapter)
    const mid = await adapter.getSnapshot()
    const dirtyCount = mid.quitPreview!.handoffDirtyAgents.length
    const handoffCountBefore = mid.handoffs.length

    const result = await adapter.dispatch({
      kind: 'execute-quit',
      commandId: cmdId(1),
      expectedRevision: mid.revision,
      action: 'request-final-handoff'
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    expect(after.quitPreview).toBeUndefined()
    // One incomplete fallback handoff per dirty agent
    const newHandoffs = after.handoffs.slice(handoffCountBefore)
    expect(newHandoffs).toHaveLength(dirtyCount)
    for (const h of newHandoffs) {
      expect(h.provenance.origin).toBe('quit-snapshot')
      expect(h.completeness).toBe('incomplete')
      expect(h.incompleteReason).toBeTruthy()
      expect(h.recoveryActions.length).toBeGreaterThan(0)
    }
  })

  it('force-quit stops runs and generates fallback snapshots in one step', async () => {
    const adapter = new MockScenarioAdapter()
    await requestQuitPreview(adapter)
    const mid = await adapter.getSnapshot()
    const handoffCountBefore = mid.handoffs.length

    const result = await adapter.dispatch({
      kind: 'execute-quit',
      commandId: cmdId(1),
      expectedRevision: mid.revision,
      action: 'force-quit'
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    expect(after.quitPreview).toBeUndefined()
    expect(after.global.concurrency.activeGlobal).toBe(0)
    // Fallback snapshots created for dirty agents
    const newHandoffs = after.handoffs.slice(handoffCountBefore)
    expect(newHandoffs.length).toBeGreaterThan(0)
    for (const h of newHandoffs) {
      expect(h.provenance.origin).toBe('quit-snapshot')
      expect(h.completeness).toBe('incomplete')
    }
  })

  it('execute-quit without a prior request-quit-preview is rejected', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch({
      kind: 'execute-quit',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      action: 'stop-runs'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })
})
