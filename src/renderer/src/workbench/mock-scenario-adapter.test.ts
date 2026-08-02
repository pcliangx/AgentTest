import { describe, it, expect } from 'vitest'
import { MockScenarioAdapter } from './mock-scenario-adapter'
import { id } from './contract'
import type {
  AgentProviderId,
  CommandId,
  ConfirmationId,
  ConnectionId,
  GlobalSurface,
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

// ---------------------------------------------------------------------------
// Navigate-global
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — navigate-global', () => {
  function navGlobal(
    commandId: CommandId,
    expectedRevision: number,
    surface: GlobalSurface
  ): WorkbenchCommand {
    return { kind: 'navigate-global', commandId, expectedRevision, surface }
  }

  it('sets activeGlobalSurface', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      navGlobal(cmdId(1), snap.revision, 'connections')
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(after.activeGlobalSurface).toBe('connections')
  })

  it('navigate clears activeGlobalSurface when returning to project', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    await adapter.dispatch(navGlobal(cmdId(1), snap.revision, 'provider-health'))
    const snap2 = await adapter.getSnapshot()
    await adapter.dispatch(navigate(cmdId(2), snap2.revision, 'overview'))
    const after = await adapter.getSnapshot()
    expect(after.activeGlobalSurface).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Confirmation flow
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — confirmation flow', () => {
  function requestDeletion(
    commandId: CommandId,
    expectedRevision: number,
    connectionId: ConnectionId
  ): WorkbenchCommand {
    return {
      kind: 'request-connection-deletion',
      commandId,
      expectedRevision,
      connectionId
    }
  }

  it('request-connection-deletion sets pendingConfirmation with display text', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const connId = snap.global.connections[0].connectionId
    const result = await adapter.dispatch(
      requestDeletion(cmdId(1), snap.revision, connId)
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(after.pendingConfirmation).toBeDefined()
    const conf = after.pendingConfirmation!
    expect(conf.confirmationId).toBeDefined()
    expect(conf.action).toBe('删除连接')
    expect(conf.target).toBe(snap.global.connections[0].label)
    expect(conf.impact).toBeTruthy()
    expect(conf.nonBypassableReason).toBeTruthy()
  })

  it('discloses affected project bindings in the impact text', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const connId = snap.global.connections[0].connectionId
    const affectedProject = snap.projects.find(
      (p) => p.primaryConnectionId === connId
    )
    if (affectedProject) {
      await adapter.dispatch(requestDeletion(cmdId(1), snap.revision, connId))
      const after = await adapter.getSnapshot()
      expect(after.pendingConfirmation!.impact).toContain(affectedProject.name)
    }
  })

  it('request-connection-deletion rejects non-existent connection', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      requestDeletion(
        cmdId(1),
        snap.revision,
        id('conn-nonexistent', 'ConnectionId') as ConnectionId
      )
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid-target')
    }
  })

  it('confirm removes the connection and records global activity', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const connId = snap.global.connections[0].connectionId
    const connLabel = snap.global.connections[0].label
    await adapter.dispatch(requestDeletion(cmdId(1), snap.revision, connId))
    const snap2 = await adapter.getSnapshot()
    const confId = snap2.pendingConfirmation!.confirmationId

    const result = await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: snap2.revision,
      confirmationId: confId
    })
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(after.pendingConfirmation).toBeUndefined()
    // Connection removed — visual result feedback
    expect(
      after.global.connections.find((c) => c.connectionId === connId)
    ).toBeUndefined()
    // Global activity recorded without projectId
    const lastActivity = after.activity[0]
    expect(lastActivity).toBeDefined()
    expect(lastActivity.summary).toContain(connLabel)
    expect(lastActivity.projectId).toBeUndefined()
  })

  it('confirm-dangerous-action with invalid ID is rejected', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      confirmationId: id('fake-id', 'ConfirmationId') as ConfirmationId
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid-target')
    }
  })

  it('dismiss-confirmation clears pendingConfirmation', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const connId = snap.global.connections[0].connectionId
    await adapter.dispatch(requestDeletion(cmdId(1), snap.revision, connId))
    const snap2 = await adapter.getSnapshot()
    expect(snap2.pendingConfirmation).toBeDefined()

    const result = await adapter.dispatch({
      kind: 'dismiss-confirmation',
      commandId: cmdId(2),
      expectedRevision: snap2.revision
    })
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(after.pendingConfirmation).toBeUndefined()
  })

  it('clears primaryConnectionId on affected projects after deletion', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const connId = snap.global.connections[0].connectionId
    const affectedProject = snap.projects.find(
      (p) => p.primaryConnectionId === connId
    )
    expect(affectedProject).toBeDefined()

    await adapter.dispatch(requestDeletion(cmdId(1), snap.revision, connId))
    const snap2 = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: snap2.revision,
      confirmationId: snap2.pendingConfirmation!.confirmationId
    })
    const after = await adapter.getSnapshot()
    const updated = after.projects.find(
      (p) => p.projectId === affectedProject!.projectId
    )!
    expect(updated.primaryConnectionId).toBeUndefined()
  })

  it('produces unique ActivityIds across multiple confirmations', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()

    // First deletion
    const conn1 = snap.global.connections[0].connectionId
    await adapter.dispatch(requestDeletion(cmdId(1), snap.revision, conn1))
    let s = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: s.revision,
      confirmationId: s.pendingConfirmation!.confirmationId
    })

    // Second deletion
    s = await adapter.getSnapshot()
    const conn2 = s.global.connections[0].connectionId
    await adapter.dispatch(requestDeletion(cmdId(3), s.revision, conn2))
    s = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(4),
      expectedRevision: s.revision,
      confirmationId: s.pendingConfirmation!.confirmationId
    })

    const after = await adapter.getSnapshot()
    const ids = after.activity.slice(0, 2).map((a) => a.activityId)
    expect(ids[0]).not.toBe(ids[1])
  })
})

// ---------------------------------------------------------------------------
// Provider recovery
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — provider recovery', () => {
  function recover(
    commandId: CommandId,
    expectedRevision: number,
    providerId: AgentProviderId
  ): WorkbenchCommand {
    return {
      kind: 'request-provider-recovery',
      commandId,
      expectedRevision,
      providerId
    }
  }

  it('changes a blocked provider to ready', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const blocked = snap.global.providers.find((p) => p.status === 'blocked')!
    const result = await adapter.dispatch(
      recover(cmdId(1), snap.revision, blocked.providerId)
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const provider = after.global.providers.find(
      (p) => p.providerId === blocked.providerId
    )!
    expect(provider.status).toBe('ready')
  })

  it('rejects non-existent provider', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      recover(
        cmdId(1),
        snap.revision,
        id('nonexistent', 'AgentProviderId') as AgentProviderId
      )
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid-target')
    }
  })
})
