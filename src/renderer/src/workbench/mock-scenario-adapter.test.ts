import { describe, it, expect } from 'vitest'
import { MockScenarioAdapter } from './mock-scenario-adapter'
import { id } from './contract'
import type {
  CommandId,
  ProjectId,
  ProjectSurface,
  WorkbenchCommand,
  WorkbenchEvent
} from './contract'

function cmdId(n: number): CommandId {
  return id(`cmd-${n}`, 'CommandId')
}

const DEFAULT_PROJECT_ID = id('proj-sales', 'ProjectId')

function navigate(
  commandId: CommandId,
  expectedRevision: number,
  surface: ProjectSurface,
  projectId: ProjectId = DEFAULT_PROJECT_ID
): WorkbenchCommand {
  return {
    kind: 'navigate',
    commandId,
    expectedRevision,
    surface,
    projectId
  }
}

// ---------------------------------------------------------------------------
// Snapshot contract
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — snapshot', () => {
  it('returns schema version 1', async () => {
    const adapter = new MockScenarioAdapter()
    const snapshot = await adapter.getSnapshot()
    expect(snapshot.schemaVersion).toBe(1)
  })

  it('exposes a monotonic, non-negative revision', async () => {
    const adapter = new MockScenarioAdapter()
    const snapshot = await adapter.getSnapshot()
    expect(snapshot.revision).toBeGreaterThanOrEqual(0)
  })

  it('renders a standard project with name, availability and readiness', async () => {
    const adapter = new MockScenarioAdapter()
    const snapshot = await adapter.getSnapshot()
    const project = snapshot.projects[0]
    expect(project).toBeDefined()
    expect(project.name).toBe('销售数据分析')
    expect(project.rootAvailability).toBe('available')
    expect(project.repositoryReadiness).toBe('ready')
    expect(project.lifecycle).toBe('active')
  })

  it('includes connection summary, agent/run/attention counts and recent activity', async () => {
    const adapter = new MockScenarioAdapter()
    const snapshot = await adapter.getSnapshot()
    const project = snapshot.projects[0]

    expect(project.primaryConnectionId).toBeDefined()
    const conn = snapshot.global.connections.find(
      (c) => c.connectionId === project.primaryConnectionId
    )
    expect(conn).toBeDefined()

    const projectAgents = snapshot.agents.filter(
      (a) => a.projectId === project.projectId
    )
    expect(projectAgents.length).toBeGreaterThan(0)
    expect(project.activeRunCount).toBeGreaterThanOrEqual(0)
    expect(project.queuedRunCount).toBeGreaterThanOrEqual(0)
    expect(project.attentionCount).toBeGreaterThanOrEqual(0)

    expect(snapshot.activity.length).toBeGreaterThan(0)
    expect(snapshot.activity[0].summary).toBeTruthy()
  })

  it('returns independent clones (mutation does not leak)', async () => {
    const adapter = new MockScenarioAdapter()
    const a = await adapter.getSnapshot()
    a.revision = 999
    const b = await adapter.getSnapshot()
    expect(b.revision).not.toBe(999)
  })
})

// ---------------------------------------------------------------------------
// Navigate command
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — navigate', () => {
  it('changes the project surface and increments revision', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      navigate(cmdId(1), before.revision, 'agents')
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.acceptedRevision).toBe(before.revision + 1)
    }
    const after = await adapter.getSnapshot()
    expect(after.projects[0].currentSurface).toBe('agents')
    expect(after.revision).toBe(before.revision + 1)
  })

  it('emits a view-model-updated event with correlationId', async () => {
    const adapter = new MockScenarioAdapter()
    const events: WorkbenchEvent[] = []
    adapter.subscribe((e) => events.push(e))
    const snapshot = await adapter.getSnapshot()
    await adapter.dispatch(navigate(cmdId(1), snapshot.revision, 'tasks'))
    const updated = events.find(
      (e): e is Extract<WorkbenchEvent, { kind: 'view-model-updated' }> =>
        e.kind === 'view-model-updated'
    )
    expect(updated).toBeDefined()
    expect(updated!.correlationId).toEqual(cmdId(1))
    expect(updated!.snapshot.projects[0].currentSurface).toBe('tasks')
  })
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — CommandId idempotency', () => {
  it('returns the same result for a duplicate commandId without extra revision bump', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const command = navigate(cmdId(1), snap.revision, 'agents')
    const first = await adapter.dispatch(command)
    const second = await adapter.dispatch(command)
    expect(second).toEqual(first)
    const after = await adapter.getSnapshot()
    expect(after.revision).toBe(snap.revision + 1) // only one bump
  })
})

// ---------------------------------------------------------------------------
// Stale revision rejection
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — stale revision', () => {
  it('rejects a command whose expectedRevision is behind', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    // First navigate succeeds, bumping revision.
    await adapter.dispatch(navigate(cmdId(1), snap.revision, 'agents'))
    // Second command uses the old revision.
    const result = await adapter.dispatch(
      navigate(cmdId(2), snap.revision, 'tasks')
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('stale-revision')
      expect(result.latestRevision).toBe(snap.revision + 1)
    }
  })
})

// ---------------------------------------------------------------------------
// Subscribe / unsubscribe
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — subscribe', () => {
  it('delivers events to active subscribers', async () => {
    const adapter = new MockScenarioAdapter()
    const received: WorkbenchEvent[] = []
    adapter.subscribe((e) => received.push(e))
    const snap = await adapter.getSnapshot()
    await adapter.dispatch(navigate(cmdId(1), snap.revision, 'agents'))
    expect(received.length).toBeGreaterThan(0)
  })

  it('stops delivering after unsubscribe', async () => {
    const adapter = new MockScenarioAdapter()
    const received: WorkbenchEvent[] = []
    const unsubscribe = adapter.subscribe((e) => received.push(e))
    unsubscribe()
    const snap = await adapter.getSnapshot()
    await adapter.dispatch(navigate(cmdId(1), snap.revision, 'agents'))
    expect(received).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Scenario-read-only for unimplemented commands
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — unimplemented commands', () => {
  it('rejects non-navigate commands with scenario-read-only', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: snap.projects[0].projectId,
      targets: [snap.agents[0].agentInstanceId],
      instruction: 'test'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('scenario-read-only')
    }
  })
})

// ---------------------------------------------------------------------------
// Invalid target
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — invalid target', () => {
  it('rejects navigate to a non-existent project with invalid-target', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      navigate(cmdId(1), snap.revision, 'overview', id('proj-nonexistent', 'ProjectId'))
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid-target')
    }
  })

  it('navigates between existing projects', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const researchId = snap.projects[1].projectId
    const result = await adapter.dispatch(
      navigate(cmdId(1), snap.revision, 'agents', researchId)
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(after.activeProjectId).toEqual(researchId)
    expect(
      after.projects.find((p) => p.projectId === researchId)!.currentSurface
    ).toBe('agents')
  })
})
