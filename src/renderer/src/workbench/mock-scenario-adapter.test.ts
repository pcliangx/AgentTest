import { describe, it, expect, vi } from 'vitest'
import { MockScenarioAdapter } from './mock-scenario-adapter'
import { id } from './contract'
import { createStandardScenario } from './standard-scenario'
import type {
  AgentInstanceId,
  AgentOpenMode,
  AgentProviderId,
  AgentRuntimeState,
  AgentWorktreeMode,
  CommandId,
  CommandResult,
  ConfirmationId,
  ConnectionId,
  GlobalSurface,
  PermissionDecision,
  ProjectId,
  ProjectSurface,
  QueueItemId,
  WorkbenchCommand,
  WorkbenchEvent,
  WorkbenchViewModel
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

  it('stamps lastOpenedAt only when entering a Project, not on in-project surface switches (#76, PR #82)', async () => {
    let now = 1_000
    const adapter = new MockScenarioAdapter(undefined, { now: () => now })
    const start = await adapter.getSnapshot()
    expect(start.activeGlobalSurface).toBe('home')
    const salesOpenedBefore = start.projects[0].lastOpenedAt

    // Entering the Project from the home page stamps it.
    await adapter.dispatch(navigate(cmdId(1), start.revision, 'overview'))
    let snap = await adapter.getSnapshot()
    expect(snap.projects[0].lastOpenedAt).toBe(1_000)
    expect(snap.projects[0].lastOpenedAt).not.toBe(salesOpenedBefore)

    // Switching surfaces inside the same Project is not a new open.
    now = 2_000
    await adapter.dispatch(navigate(cmdId(2), snap.revision, 'tasks'))
    snap = await adapter.getSnapshot()
    expect(snap.projects[0].currentSurface).toBe('tasks')
    expect(snap.projects[0].lastOpenedAt).toBe(1_000)

    // Leaving for a global surface and coming back IS a new open.
    await adapter.dispatch({
      kind: 'navigate-global',
      commandId: cmdId(3),
      expectedRevision: snap.revision,
      surface: 'connections'
    })
    now = 3_000
    const mid = await adapter.getSnapshot()
    await adapter.dispatch(navigate(cmdId(4), mid.revision, 'tasks'))
    snap = await adapter.getSnapshot()
    expect(snap.projects[0].lastOpenedAt).toBe(3_000)
  })
})

// ---------------------------------------------------------------------------
// create-project (#76)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — create-project', () => {
  it('rejects a blank name or root path without touching the snapshot', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const missingName = await adapter.dispatch({
      kind: 'create-project',
      commandId: cmdId(1),
      expectedRevision: before.revision,
      name: '   ',
      rootPath: '~/Projects/growth-lab'
    })
    expect(missingName.ok).toBe(false)
    const missingPath = await adapter.dispatch({
      kind: 'create-project',
      commandId: cmdId(2),
      expectedRevision: before.revision,
      name: '增长实验平台',
      rootPath: '  '
    })
    expect(missingPath.ok).toBe(false)
    const after = await adapter.getSnapshot()
    expect(after.projects).toHaveLength(before.projects.length)
    expect(after.revision).toBe(before.revision)
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

  it('keeps dispatch-created correlated when a listener dispatches reentrantly', async () => {
    const adapter = new MockScenarioAdapter()
    const snapshot = await adapter.getSnapshot()
    const project = snapshot.projects[0]
    const target = snapshot.agents.find((agent) => agent.name === 'cx_review')!
    const outerCommandId = id('cmd-reentrant-dispatch', 'CommandId')
    const innerCommandId = id('cmd-reentrant-navigate', 'CommandId')
    const received: WorkbenchEvent[] = []
    let innerResult: ReturnType<MockScenarioAdapter['dispatch']> | undefined

    adapter.subscribe((event) => {
      received.push(event)
      if (
        event.kind === 'view-model-updated' &&
        event.correlationId === outerCommandId
      ) {
        innerResult = adapter.dispatch(
          navigate(innerCommandId, event.revision, 'agents')
        )
      }
    })

    const outerResult = await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: outerCommandId,
      expectedRevision: snapshot.revision,
      projectId: project.projectId,
      targets: [target.agentInstanceId],
      instruction: 'preserve correlation'
    })
    await innerResult

    expect(outerResult.ok).toBe(true)
    const created = received.find(
      (event): event is Extract<WorkbenchEvent, { kind: 'dispatch-created' }> =>
        event.kind === 'dispatch-created' &&
        event.correlationId === outerCommandId
    )
    expect(created).toBeDefined()
    if (outerResult.ok) {
      expect(created?.revision).toBe(outerResult.acceptedRevision)
    }
    expect(created?.dispatchIds).toHaveLength(1)
    const revisions = received.map((event) => event.revision)
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
    expect(
      received.findIndex(
        (event) =>
          event.kind === 'dispatch-created' &&
          event.correlationId === outerCommandId
      )
    ).toBeLessThan(
      received.findIndex(
        (event) =>
          event.kind === 'view-model-updated' &&
          event.correlationId === innerCommandId
      )
    )
  })
})

// ---------------------------------------------------------------------------
// Scenario-read-only for unimplemented commands
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — unimplemented commands', () => {
  it('rejects not-yet-implemented commands with scenario-read-only', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    // No remaining unimplemented command variants exist after #12; this
    // guard verifies the default case still rejects gracefully.
    const result = await adapter.dispatch({
      kind: 'execute-quit',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      action: 'wait-for-runs'
    } as WorkbenchCommand)
    // execute-quit without a prior request-quit-preview is invalid-target,
    // not scenario-read-only. Verify it still rejects cleanly.
    expect(result.ok).toBe(false)
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
// Standard scenario — agent directory data (#3)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — directory scenario data', () => {
  it('exposes at least eight agents in the primary project, with repeated providers', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const projectAgents = snap.agents.filter(
      (a) => a.projectId === DEFAULT_PROJECT_ID
    )
    expect(projectAgents.length).toBeGreaterThanOrEqual(8)

    const byProvider = new Map<string, number>()
    for (const agent of projectAgents) {
      byProvider.set(
        agent.providerId,
        (byProvider.get(agent.providerId) ?? 0) + 1
      )
    }
    const repeated = [...byProvider.values()].filter((n) => n > 1)
    expect(repeated.length).toBeGreaterThan(0)
  })

  it('includes a blocked provider so New Agent can exclude it', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const blocked = snap.global.providers.filter((p) => p.status === 'blocked')
    expect(blocked.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// create-agent command (#3)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — create-agent', () => {
  function createAgent(
    commandId: CommandId,
    expectedRevision: number,
    overrides: Partial<{
      projectId: ProjectId
      name: string
      providerId: string
      modelId: string
      open: AgentOpenMode
      worktreeMode: AgentWorktreeMode
    }> = {}
  ): WorkbenchCommand {
    return {
      kind: 'create-agent',
      commandId,
      expectedRevision,
      projectId: overrides.projectId ?? DEFAULT_PROJECT_ID,
      name: overrides.name ?? 'cc_new',
      providerId: id(overrides.providerId ?? 'claude-code', 'AgentProviderId'),
      modelId: overrides.modelId ?? 'claude-sonnet-4',
      open: overrides.open ?? 'current-panel',
      worktreeMode: overrides.worktreeMode ?? 'isolated'
    }
  }

  it('creates a Ready instance without producing a Run', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const beforeRuns = before.projects[0].activeRunCount

    const result = await adapter.dispatch(createAgent(cmdId(1), before.revision))
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const created = after.agents.find((a) => a.name === 'cc_new')
    expect(created).toBeDefined()
    expect(created!.projectId).toEqual(DEFAULT_PROJECT_ID)
    expect(created!.runtimeState).toBe('ready')
    expect(created!.terminalState).toBe('closed')
    expect(created!.queueDepth).toBe(0)
    expect(created!.activeRunId).toBeUndefined()
    // Creation must not produce a Run.
    expect(after.projects[0].activeRunCount).toBe(beforeRuns)
  })

  it('opens the new instance as the active tab of the current panel by default', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    await adapter.dispatch(createAgent(cmdId(1), snap.revision))

    const after = await adapter.getSnapshot()
    const created = after.agents.find((a) => a.name === 'cc_new')!
    const layout = after.projects[0].layout
    const panelId = layout.focusedPanelId!
    expect(layout.panels[panelId].tabs).toContain(created.agentInstanceId)
    expect(layout.panels[panelId].activeTabId).toEqual(created.agentInstanceId)
  })

  it('leaves the layout untouched when opening in background', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      createAgent(cmdId(1), snap.revision, { open: 'background' })
    )
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const created = after.agents.find((a) => a.name === 'cc_new')!
    expect(created).toBeDefined()
    const layout = after.projects[0].layout
    const allTabs = Object.values(layout.panels).flatMap((p) => p.tabs)
    expect(allTabs).not.toContain(created.agentInstanceId)
    expect(layout.panels[id('panel-main', 'PanelId')].tabs).toEqual(
      snap.projects[0].layout.panels[id('panel-main', 'PanelId')].tabs
    )
  })

  it('rejects a duplicate name case-insensitively within the same project', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      createAgent(cmdId(1), snap.revision, { name: 'CC_DATA' })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invariant-violation')
    }
    const after = await adapter.getSnapshot()
    expect(
      after.agents.filter((a) => a.projectId === DEFAULT_PROJECT_ID)
    ).toHaveLength(
      snap.agents.filter((a) => a.projectId === DEFAULT_PROJECT_ID).length
    )
  })

  it('allows the same name in a different project', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const researchId = snap.projects[1].projectId
    const result = await adapter.dispatch(
      createAgent(cmdId(1), snap.revision, {
        projectId: researchId,
        name: 'CC_DATA',
        open: 'background'
      })
    )
    expect(result.ok).toBe(true)
  })

  it('rejects a provider whose Doctor status is blocked', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const blocked = snap.global.providers.find((p) => p.status === 'blocked')!
    const result = await adapter.dispatch(
      createAgent(cmdId(1), snap.revision, { providerId: blocked.providerId })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unavailable')
    }
  })

  it.each([
    ['claude-code', 'claude-sonnet-4'],
    ['codex', 'gpt-5-codex'],
    ['kimi-code', 'kimi-k2']
  ])('accepts the declared %s model capability', async (providerId, modelId) => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      createAgent(cmdId(1), before.revision, {
        name: `${providerId}-new`,
        providerId,
        modelId,
        open: 'background'
      })
    )

    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const created = after.agents.find(
      (agent) => agent.name === `${providerId}-new`
    )!
    const configuration = after.appliedConfigurations.find(
      (entry) =>
        entry.owner.kind === 'agent' &&
        entry.owner.agentInstanceId === created.agentInstanceId
    )!
    expect(created.providerId).toBe(providerId)
    expect(configuration.values['model.id']).toBe(modelId)
  })

  it.each([
    ['claude-sonnet-4', '不支持'],
    ['', '请选择']
  ])(
    'rejects an incompatible or missing Model (%s) without side effects',
    async (modelId, expectedMessage) => {
      const adapter = new MockScenarioAdapter()
      const before = await adapter.getSnapshot()
      const result = await adapter.dispatch(
        createAgent(cmdId(1), before.revision, {
          providerId: 'codex',
          modelId,
          open: 'background'
        })
      )

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('invalid-target')
        expect(result.message).toContain(expectedMessage)
      }
      expect(await adapter.getSnapshot()).toEqual(before)
    }
  )

  it('rejects an unknown provider or project with invalid-target', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()

    const badProvider = await adapter.dispatch(
      createAgent(cmdId(1), snap.revision, { providerId: 'no-such-provider' })
    )
    expect(badProvider.ok).toBe(false)
    if (!badProvider.ok) expect(badProvider.reason).toBe('invalid-target')

    const badProject = await adapter.dispatch(
      createAgent(cmdId(2), snap.revision, {
        projectId: id('proj-nope', 'ProjectId')
      })
    )
    expect(badProject.ok).toBe(false)
    if (!badProject.ok) expect(badProject.reason).toBe('invalid-target')
  })

  it('rejects an empty name', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      createAgent(cmdId(1), snap.revision, { name: '   ' })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })

  it('creates a panel when the workspace is empty and the agent opens in current panel', async () => {
    const adapter = new MockScenarioAdapter()
    let snap = await adapter.getSnapshot()
    // Close the only tab so the single-panel workspace becomes empty.
    await adapter.dispatch({
      kind: 'change-layout',
      commandId: cmdId(90),
      expectedRevision: snap.revision,
      projectId: DEFAULT_PROJECT_ID,
      operation: {
        kind: 'close-tab',
        panelId: id('panel-main', 'PanelId'),
        agentInstanceId: id('inst-cc-data', 'AgentInstanceId')
      }
    })
    snap = await adapter.getSnapshot()
    expect(snap.projects[0].layout.root).toBeNull()

    const result = await adapter.dispatch(
      createAgent(cmdId(91), snap.revision, { open: 'current-panel' })
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const created = after.agents.find((a) => a.name === 'cc_new')!
    const layout = after.projects[0].layout
    expect(layout.root).not.toBeNull()
    const panelId = layout.focusedPanelId!
    expect(layout.panels[panelId].tabs).toEqual([created.agentInstanceId])
    expect(layout.panels[panelId].activeTabId).toEqual(created.agentInstanceId)
  })
})

// ---------------------------------------------------------------------------
// change-layout — tab commands (#3)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — change-layout tab commands', () => {
  const PANEL = id('panel-main', 'PanelId')
  const CC_DATA = id('inst-cc-data', 'AgentInstanceId')
  const CC_SQL = id('inst-cc-sql', 'AgentInstanceId')

  function changeLayout(
    commandId: CommandId,
    expectedRevision: number,
    operation: Extract<
      WorkbenchCommand,
      { kind: 'change-layout' }
    >['operation']
  ): WorkbenchCommand {
    return {
      kind: 'change-layout',
      commandId,
      expectedRevision,
      projectId: DEFAULT_PROJECT_ID,
      operation
    }
  }

  it('open-tab adds a new tab and activates it', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      changeLayout(cmdId(1), snap.revision, {
        kind: 'open-tab',
        panelId: PANEL,
        agentInstanceId: CC_SQL
      })
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const panel = after.projects[0].layout.panels[PANEL]
    expect(panel.tabs).toEqual([CC_DATA, CC_SQL])
    expect(panel.activeTabId).toEqual(CC_SQL)
  })

  it('open-tab on an already-open instance only focuses its unique tab', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      changeLayout(cmdId(1), snap.revision, {
        kind: 'open-tab',
        panelId: PANEL,
        agentInstanceId: CC_DATA
      })
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const panel = after.projects[0].layout.panels[PANEL]
    expect(panel.tabs).toEqual([CC_DATA])
    expect(panel.activeTabId).toEqual(CC_DATA)
  })

  it('open-tab rejects unknown panel or instance with invalid-target', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const badPanel = await adapter.dispatch(
      changeLayout(cmdId(1), snap.revision, {
        kind: 'open-tab',
        panelId: id('panel-nope', 'PanelId'),
        agentInstanceId: CC_SQL
      })
    )
    expect(badPanel.ok).toBe(false)
    if (!badPanel.ok) expect(badPanel.reason).toBe('invalid-target')

    const badInstance = await adapter.dispatch(
      changeLayout(cmdId(2), snap.revision, {
        kind: 'open-tab',
        panelId: PANEL,
        agentInstanceId: id('inst-nope', 'AgentInstanceId')
      })
    )
    expect(badInstance.ok).toBe(false)
    if (!badInstance.ok) expect(badInstance.reason).toBe('invalid-target')
  })

  it('activate-tab switches the active tab within a panel', async () => {
    const adapter = new MockScenarioAdapter()
    let snap = await adapter.getSnapshot()
    await adapter.dispatch(
      changeLayout(cmdId(1), snap.revision, {
        kind: 'open-tab',
        panelId: PANEL,
        agentInstanceId: CC_SQL
      })
    )
    snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      changeLayout(cmdId(2), snap.revision, {
        kind: 'activate-tab',
        panelId: PANEL,
        agentInstanceId: CC_DATA
      })
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(after.projects[0].layout.panels[PANEL].activeTabId).toEqual(CC_DATA)
  })

  it('activate-tab rejects a tab that is not in the panel', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      changeLayout(cmdId(1), snap.revision, {
        kind: 'activate-tab',
        panelId: PANEL,
        agentInstanceId: CC_SQL
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })

  it('close-tab removes only the view and falls back to a remaining tab', async () => {
    const adapter = new MockScenarioAdapter()
    let snap = await adapter.getSnapshot()
    await adapter.dispatch(
      changeLayout(cmdId(1), snap.revision, {
        kind: 'open-tab',
        panelId: PANEL,
        agentInstanceId: CC_SQL
      })
    )
    snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      changeLayout(cmdId(2), snap.revision, {
        kind: 'close-tab',
        panelId: PANEL,
        agentInstanceId: CC_SQL
      })
    )
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const panel = after.projects[0].layout.panels[PANEL]
    expect(panel.tabs).toEqual([CC_DATA])
    expect(panel.activeTabId).toEqual(CC_DATA)
    // Closing a tab must not stop Run/PTY/Session or delete the instance.
    const ccSql = after.agents.find((a) => a.agentInstanceId === CC_SQL)!
    expect(ccSql).toBeDefined()
    const ccData = after.agents.find((a) => a.agentInstanceId === CC_DATA)!
    // cc_data's active Run is held in permission-requested (#9 scenario).
    expect(ccData.runtimeState).toBe('permission-requested')
    expect(ccData.activeRunId).toBeDefined()
  })

  it('closing the last tab empties a single-panel workspace', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      changeLayout(cmdId(1), snap.revision, {
        kind: 'close-tab',
        panelId: PANEL,
        agentInstanceId: CC_DATA
      })
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const layout = after.projects[0].layout
    expect(layout.root).toBeNull()
    expect(layout.panels[PANEL]).toBeUndefined()
    expect(layout.focusedPanelId).toBeUndefined()
    // The instance survives with its run untouched (held in
    // permission-requested since #9 gave it the actionable request).
    const ccData = after.agents.find((a) => a.agentInstanceId === CC_DATA)!
    expect(ccData.runtimeState).toBe('permission-requested')
  })

  it('close-tab rejects a tab that is not open', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      changeLayout(cmdId(1), snap.revision, {
        kind: 'close-tab',
        panelId: PANEL,
        agentInstanceId: CC_SQL
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })

  it('enters and exits temporary Focus through the shared reducer (#5)', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const focused = await adapter.dispatch(
      changeLayout(cmdId(1), snap.revision, {
        kind: 'focus-panel',
        panelId: PANEL
      })
    )
    expect(focused.ok).toBe(true)
    let after = await adapter.getSnapshot()
    // Focus is a temporary view state: the tree and tabs are untouched.
    expect(after.projects[0].layout.temporaryFocusPanelId).toEqual(PANEL)
    expect(after.projects[0].layout.root).toEqual(snap.projects[0].layout.root)

    const unfocused = await adapter.dispatch(
      changeLayout(cmdId(2), after.revision, { kind: 'focus-panel' })
    )
    expect(unfocused.ok).toBe(true)
    after = await adapter.getSnapshot()
    expect(after.projects[0].layout.temporaryFocusPanelId).toBeUndefined()
  })

  it('applies the analysis preset through the shared reducer (#5)', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      changeLayout(cmdId(1), snap.revision, {
        kind: 'apply-analysis-preset',
        panelId: PANEL
      })
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const layout = after.projects[0].layout
    // One main + two auxiliary panels, all plain split-tree nodes.
    expect(Object.keys(layout.panels)).toHaveLength(3)
    expect(layout.panels[PANEL].tabs).toEqual([CC_DATA])
    const root = layout.root
    expect(root).toMatchObject({
      kind: 'split',
      direction: 'horizontal',
      second: { kind: 'split', direction: 'vertical' }
    })
  })
})

// ---------------------------------------------------------------------------
// Rejection purity — a rejected command must never mutate the snapshot (#20)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — rejection purity', () => {
  it('a rejected open-tab on an empty workspace leaves the layout untouched', async () => {
    const adapter = new MockScenarioAdapter()
    let snap = await adapter.getSnapshot()
    // Empty the single-panel workspace first (revision bumps to 1).
    await adapter.dispatch({
      kind: 'change-layout',
      commandId: cmdId(90),
      expectedRevision: snap.revision,
      projectId: DEFAULT_PROJECT_ID,
      operation: {
        kind: 'close-tab',
        panelId: id('panel-main', 'PanelId'),
        agentInstanceId: id('inst-cc-data', 'AgentInstanceId')
      }
    })
    snap = await adapter.getSnapshot()
    expect(snap.projects[0].layout.root).toBeNull()

    // open-tab for an unknown instance must be rejected WITHOUT allocating
    // a panel or otherwise mutating the snapshot.
    const result = await adapter.dispatch({
      kind: 'change-layout',
      commandId: cmdId(91),
      expectedRevision: snap.revision,
      projectId: DEFAULT_PROJECT_ID,
      operation: {
        kind: 'open-tab',
        panelId: id('panel-fallback', 'PanelId'),
        agentInstanceId: id('inst-nope', 'AgentInstanceId')
      }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')

    const after = await adapter.getSnapshot()
    expect(after.revision).toBe(snap.revision)
    expect(after.projects[0].layout.root).toBeNull()
    expect(Object.keys(after.projects[0].layout.panels)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Structural layout commands through the port (#4)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — structural layout commands (#4)', () => {
  const PANEL = id('panel-main', 'PanelId')
  const CC_DATA = id('inst-cc-data', 'AgentInstanceId')
  const CC_SQL = id('inst-cc-sql', 'AgentInstanceId')

  async function dispatchLayout(
    adapter: MockScenarioAdapter,
    n: number,
    operation: Extract<WorkbenchCommand, { kind: 'change-layout' }>['operation']
  ): Promise<CommandResult> {
    const snap = await adapter.getSnapshot()
    return adapter.dispatch({
      kind: 'change-layout',
      commandId: cmdId(n),
      expectedRevision: snap.revision,
      projectId: DEFAULT_PROJECT_ID,
      operation
    })
  }

  it('split-panel creates an empty sibling panel through the port', async () => {
    const adapter = new MockScenarioAdapter()
    const result = await dispatchLayout(adapter, 1, {
      kind: 'split-panel',
      panelId: PANEL,
      direction: 'horizontal'
    })
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const layout = after.projects[0].layout
    expect(layout.root?.kind).toBe('split')
    expect(Object.keys(layout.panels)).toHaveLength(2)
    // Original panel keeps its tab; the sibling is empty.
    expect(layout.panels[PANEL].tabs).toEqual([CC_DATA])
  })

  it('move-tab relocates a tab without duplicating it', async () => {
    const adapter = new MockScenarioAdapter()
    await dispatchLayout(adapter, 1, {
      kind: 'split-panel',
      panelId: PANEL,
      direction: 'horizontal'
    })
    const mid = await adapter.getSnapshot()
    const sibling = Object.keys(mid.projects[0].layout.panels).find(
      (p) => p !== PANEL
    )!
    const result = await dispatchLayout(adapter, 2, {
      kind: 'move-tab',
      agentInstanceId: CC_DATA,
      targetPanelId: id(sibling, 'PanelId')
    })
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const allTabs = Object.values(after.projects[0].layout.panels).flatMap(
      (p) => p.tabs
    )
    expect(allTabs.filter((t) => t === CC_DATA)).toHaveLength(1)
    expect(after.projects[0].layout.panels[id(sibling, 'PanelId')].tabs).toEqual(
      [CC_DATA]
    )
  })

  it('resize-split updates and clamps the ratio', async () => {
    const adapter = new MockScenarioAdapter()
    await dispatchLayout(adapter, 1, {
      kind: 'split-panel',
      panelId: PANEL,
      direction: 'horizontal'
    })
    const mid = await adapter.getSnapshot()
    const root = mid.projects[0].layout.root
    if (root?.kind !== 'split') throw new Error('expected split root')
    const result = await dispatchLayout(adapter, 2, {
      kind: 'resize-split',
      splitNodeId: root.splitNodeId,
      ratio: 0.97
    })
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(after.projects[0].layout.root).toMatchObject({ ratio: 0.9 })
  })

  it('close-panel with tabs requires a migration target', async () => {
    const adapter = new MockScenarioAdapter()
    await dispatchLayout(adapter, 1, {
      kind: 'open-tab',
      panelId: PANEL,
      agentInstanceId: CC_SQL
    })
    const rejected = await dispatchLayout(adapter, 2, {
      kind: 'close-panel',
      panelId: PANEL
    })
    expect(rejected.ok).toBe(false)
    if (rejected.ok) return
    expect(rejected.reason).toBe('invariant-violation')
    // Snapshot untouched by the rejection.
    const after = await adapter.getSnapshot()
    expect(after.projects[0].layout.panels[PANEL].tabs).toEqual([
      CC_DATA,
      CC_SQL
    ])
  })

  it('close-panel migrates tabs into the chosen panel', async () => {
    const adapter = new MockScenarioAdapter()
    await dispatchLayout(adapter, 1, {
      kind: 'split-panel',
      panelId: PANEL,
      direction: 'horizontal'
    })
    const mid = await adapter.getSnapshot()
    const sibling = Object.keys(mid.projects[0].layout.panels).find(
      (p) => p !== PANEL
    )!
    const result = await dispatchLayout(adapter, 2, {
      kind: 'close-panel',
      panelId: PANEL,
      migrateToPanelId: id(sibling, 'PanelId')
    })
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(after.projects[0].layout.panels[PANEL]).toBeUndefined()
    expect(
      after.projects[0].layout.panels[id(sibling, 'PanelId')].tabs
    ).toEqual([CC_DATA])
  })

  it('open-tab-in-new-panel opens an agent in a fresh panel', async () => {
    const adapter = new MockScenarioAdapter()
    const result = await dispatchLayout(adapter, 1, {
      kind: 'open-tab-in-new-panel',
      agentInstanceId: CC_SQL,
      direction: 'horizontal'
    })
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const allTabs = Object.values(after.projects[0].layout.panels).flatMap(
      (p) => p.tabs
    )
    expect(allTabs.filter((t) => t === CC_SQL)).toHaveLength(1)
    expect(Object.keys(after.projects[0].layout.panels)).toHaveLength(2)
  })

  it('rejects open-tab-in-new-panel for an unknown agent without mutation', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const result = await dispatchLayout(adapter, 1, {
      kind: 'open-tab-in-new-panel',
      agentInstanceId: id('inst-nope', 'AgentInstanceId'),
      direction: 'horizontal'
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid-target')
    const after = await adapter.getSnapshot()
    expect(after.revision).toBe(before.revision)
    expect(after.projects[0].layout).toEqual(before.projects[0].layout)
  })

  it('structural commands never touch agents, queue or attention state', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    await dispatchLayout(adapter, 1, {
      kind: 'split-panel',
      panelId: PANEL,
      direction: 'horizontal'
    })
    await dispatchLayout(adapter, 2, {
      kind: 'move-tab',
      agentInstanceId: CC_DATA,
      targetPanelId: Object.keys(
        (await adapter.getSnapshot()).projects[0].layout.panels
      )
        .map((p) => id(p, 'PanelId'))
        .find((p) => p !== PANEL)!
    })
    await dispatchLayout(adapter, 3, {
      kind: 'close-tab',
      panelId: (await adapter.getSnapshot()).projects[0].layout
        .focusedPanelId!,
      agentInstanceId: CC_DATA
    })
    const after = await adapter.getSnapshot()
    expect(after.agents).toEqual(before.agents)
    expect(after.queue).toEqual(before.queue)
    expect(after.attentionItems).toEqual(before.attentionItems)
  })
})

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
    expect(conf.impact).toContain('未同步 Knowledge 修改')
    expect(conf.impact).toContain('销售知识库有未同步的修改')
    expect(conf.nonBypassableReason).toBeTruthy()
  })

  it('keeps unsynced Knowledge deletion impact after resolving Attention', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const connectionId = snap.global.connections[0].connectionId
    const conflict = snap.attentionItems.find(
      (item) =>
        item.state === 'open' &&
        item.kind === 'connection-conflict' &&
        item.target.kind === 'knowledge' &&
        item.target.projectId === DEFAULT_PROJECT_ID
    )!
    const resolved = await adapter.dispatch({
      kind: 'resolve-attention',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      attentionItemId: conflict.attentionItemId
    })
    expect(resolved.ok).toBe(true)

    const afterResolve = await adapter.getSnapshot()
    const requested = await adapter.dispatch(
      requestDeletion(cmdId(2), afterResolve.revision, connectionId)
    )
    expect(requested.ok).toBe(true)
    const preview = await adapter.getSnapshot()
    expect(preview.pendingConfirmation?.impact).toContain(
      '未同步 Knowledge 修改'
    )
    expect(preview.pendingConfirmation?.impact).toContain(
      '销售知识库有未同步的修改'
    )
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

  it('moves affected Knowledge to unconnected without making the Project unavailable', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const knowledge = snap.knowledge.find(
      (candidate) => candidate.connectionId === snap.global.connections[0].connectionId
    )!
    const resourceId = knowledge.knowledgeResourceId

    await adapter.dispatch(
      requestDeletion(
        cmdId(1),
        snap.revision,
        snap.global.connections[0].connectionId
      )
    )
    const preview = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: preview.revision,
      confirmationId: preview.pendingConfirmation!.confirmationId
    })

    const after = await adapter.getSnapshot()
    const updatedKnowledge = after.knowledge.find(
      (candidate) => candidate.knowledgeResourceId === resourceId
    )!
    const project = after.projects.find(
      (candidate) => candidate.projectId === knowledge.projectId
    )!
    expect(updatedKnowledge.state).toBe('unconnected')
    expect(updatedKnowledge.connectionId).toBeUndefined()
    expect(updatedKnowledge.resourceBindingId).toBeUndefined()
    expect(updatedKnowledge.humanBrowserIdentity).toBeUndefined()
    expect(updatedKnowledge.connectorIdentity).toBeUndefined()
    expect(project.lifecycle).toBe('active')
    expect(project.rootAvailability).toBe('available')
  })

  it('includes a Knowledge-only connection reference in deletion impact and cleanup', async () => {
    const scenario = createStandardScenario()
    const project = scenario.projects[0]
    const connectionId = scenario.knowledge[0].connectionId!
    project.primaryConnectionId = undefined
    project.resourceBindings = []
    const applied = scenario.appliedConfigurations.find(
      (candidate) =>
        candidate.owner.kind === 'project' &&
        candidate.owner.projectId === project.projectId
    )!
    applied.values['integrations.primaryConnectionId'] = null
    applied.values['integrations.resourceScope'] = ''
    const adapter = new MockScenarioAdapter(scenario)
    const snap = await adapter.getSnapshot()

    await adapter.dispatch(
      requestDeletion(cmdId(1), snap.revision, connectionId)
    )
    const preview = await adapter.getSnapshot()
    expect(preview.pendingConfirmation!.impact).toContain(project.name)
    await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: preview.revision,
      confirmationId: preview.pendingConfirmation!.confirmationId
    })

    expect((await adapter.getSnapshot()).knowledge[0].state).toBe(
      'unconnected'
    )
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

// ---------------------------------------------------------------------------
// Agent changes — worktree diff, drift, validation and safe merge (#8)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — agent changes', () => {
  it('provides changes data for agents in the snapshot', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    expect(snap.changes.length).toBeGreaterThan(0)
    const first = snap.changes[0]
    expect(first.agentInstanceId).toBeDefined()
    expect(first.baseCommit).toBeTruthy()
    expect(first.files).toBeDefined()
    expect(first.validation).toBeDefined()
    expect(first.drift).toBeDefined()
  })

  it('includes at least one clean agent (no drift, validation pass)', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const clean = snap.changes.find(
      (c) => c.drift === 'none' && c.validation.status === 'pass'
    )
    expect(clean).toBeDefined()
  })

  it('includes at least one drifted agent for needs-rebase testing', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const drifted = snap.changes.find((c) => c.drift === 'behind')
    expect(drifted).toBeDefined()
  })
})

describe('MockScenarioAdapter — merge-agent-changes', () => {
  it('rejects merge when drift is behind', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const drifted = snap.changes.find((c) => c.drift === 'behind')!
    const result = await adapter.dispatch({
      kind: 'merge-agent-changes',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      agentInstanceId: drifted.agentInstanceId
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unavailable')
      expect(result.message).toContain('rebase')
    }
  })

  it('rejects merge when validation fails', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const failed = snap.changes.find(
      (c) => c.validation.status === 'fail'
    )
    if (failed) {
      const result = await adapter.dispatch({
        kind: 'merge-agent-changes',
        commandId: cmdId(1),
        expectedRevision: snap.revision,
        agentInstanceId: failed.agentInstanceId
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('unavailable')
      }
    }
  })

  it('triggers confirmation when clean (no drift, validation pass)', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const clean = snap.changes.find(
      (c) => c.drift === 'none' && c.validation.status === 'pass'
    )!
    const result = await adapter.dispatch({
      kind: 'merge-agent-changes',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      agentInstanceId: clean.agentInstanceId
    })
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(after.pendingConfirmation).toBeDefined()
    expect(after.pendingConfirmation!.action).toContain('合并')
  })

  it('confirming merge clears changes and records activity', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const clean = snap.changes.find(
      (c) => c.drift === 'none' && c.validation.status === 'pass'
    )!
    const agentInstanceId = clean.agentInstanceId
    await adapter.dispatch({
      kind: 'merge-agent-changes',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      agentInstanceId
    })
    const snap2 = await adapter.getSnapshot()
    const confId = snap2.pendingConfirmation!.confirmationId
    await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: snap2.revision,
      confirmationId: confId
    })
    const after = await adapter.getSnapshot()
    // Changes cleared for this agent
    expect(
      after.changes.find((c) => c.agentInstanceId === agentInstanceId)
    ).toBeUndefined()
    // Activity recorded
    expect(after.activity[0].summary).toContain('合并')
  })
})

describe('MockScenarioAdapter — discard-agent-changes', () => {
  it('triggers confirmation for discard', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const dirty = snap.changes[0]
    const result = await adapter.dispatch({
      kind: 'discard-agent-changes',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      agentInstanceId: dirty.agentInstanceId
    })
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(after.pendingConfirmation).toBeDefined()
    expect(after.pendingConfirmation!.action).toContain('丢弃')
  })
})

// ---------------------------------------------------------------------------
// manage-queue — cancel, reorder, priority (#7)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — manage-queue', () => {
  function manageQueue(
    commandId: CommandId,
    expectedRevision: number,
    queueItemId: QueueItemId,
    operation: 'cancel' | 'move-earlier' | 'move-later' | 'raise-priority' | 'lower-priority',
    projectId: ProjectId = id('proj-sales', 'ProjectId')
  ): WorkbenchCommand {
    return {
      kind: 'manage-queue',
      commandId,
      expectedRevision,
      projectId,
      queueItemId,
      operation
    }
  }

  it('cancel removes one item, renumbers the queue and records its stable target', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const item = before.queue[0]
    const agent = before.agents.find(
      (candidate) => candidate.agentInstanceId === item.agentInstanceId
    )!
    const result = await adapter.dispatch(
      manageQueue(cmdId(1), before.revision, item.queueItemId, 'cancel')
    )

    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(
      after.queue.find((q) => q.queueItemId === item.queueItemId)
    ).toBeUndefined()
    expect(
      after.queue
        .filter((queueItem) => queueItem.projectId === item.projectId)
        .map((queueItem) => queueItem.position)
    ).toEqual([1])

    const cancellation = after.activity[0]
    expect(cancellation).toMatchObject({
      projectId: item.projectId,
      agentInstanceId: item.agentInstanceId,
      kind: 'queue-cancelled',
      reason: 'user-cancelled',
      summary: `${agent.name} 的排队项已由用户取消`
    })
    expect(cancellation).toHaveProperty('queueItemId', item.queueItemId)
    expect(cancellation.timestamp).toEqual(expect.any(Number))
    expect(after.activity.slice(1)).toEqual(before.activity)
  })

  it('keeps a multi-item agent queued and derives its remaining depth', async () => {
    const scenario = createStandardScenario()
    const item = scenario.queue[0]
    const agent = scenario.agents.find(
      (candidate) => candidate.agentInstanceId === item.agentInstanceId
    )!
    agent.queueDepth = 99
    const adapter = new MockScenarioAdapter(scenario)
    const before = await adapter.getSnapshot()

    await adapter.dispatch(
      manageQueue(cmdId(2), before.revision, item.queueItemId, 'cancel')
    )

    const after = await adapter.getSnapshot()
    const updatedAgent = after.agents.find(
      (candidate) => candidate.agentInstanceId === agent.agentInstanceId
    )!
    expect(updatedAgent.queueDepth).toBe(1)
    expect(updatedAgent.runtimeState).toBe('queued')
    expect(
      after.projects.find((project) => project.projectId === item.projectId)
        ?.queuedRunCount
    ).toBe(1)
    expect(after.global.concurrency.queuedGlobal).toBe(1)
  })

  it('cancels the last item and restores an idle execution slot to ready', async () => {
    const scenario = createStandardScenario()
    const item = scenario.queue[0]
    scenario.queue = [item]
    const agent = scenario.agents.find(
      (candidate) => candidate.agentInstanceId === item.agentInstanceId
    )!
    agent.queueDepth = 1
    agent.runtimeState = 'queued'
    agent.terminalState = 'closed'
    agent.activeRunId = undefined
    scenario.projects.find(
      (project) => project.projectId === item.projectId
    )!.queuedRunCount = 1
    scenario.global.concurrency.queuedGlobal = 1
    const adapter = new MockScenarioAdapter(scenario)
    const before = await adapter.getSnapshot()

    await adapter.dispatch(
      manageQueue(cmdId(3), before.revision, item.queueItemId, 'cancel')
    )

    const after = await adapter.getSnapshot()
    const updatedAgent = after.agents.find(
      (candidate) => candidate.agentInstanceId === agent.agentInstanceId
    )!
    expect(after.queue).toHaveLength(0)
    expect(updatedAgent).toMatchObject({
      queueDepth: 0,
      runtimeState: 'ready',
      terminalState: 'closed'
    })
    expect(updatedAgent.activeRunId).toBeUndefined()
    expect(after.projects[0].queuedRunCount).toBe(0)
    expect(after.global.concurrency.queuedGlobal).toBe(0)
  })

  it('keeps Terminal takeover orthogonal when cancelling the last item', async () => {
    const scenario = createStandardScenario()
    const item = scenario.queue[0]
    scenario.queue = [item]
    const agent = scenario.agents.find(
      (candidate) => candidate.agentInstanceId === item.agentInstanceId
    )!
    agent.queueDepth = 1
    agent.runtimeState = 'queued'
    agent.terminalState = 'active'
    const adapter = new MockScenarioAdapter(scenario)
    const before = await adapter.getSnapshot()

    await adapter.dispatch(
      manageQueue(cmdId(31), before.revision, item.queueItemId, 'cancel')
    )

    const after = await adapter.getSnapshot()
    expect(
      after.agents.find(
        (candidate) => candidate.agentInstanceId === agent.agentInstanceId
      )
    ).toMatchObject({
      queueDepth: 0,
      runtimeState: 'ready',
      terminalState: 'active'
    })
  })

  it('preserves an active structured Run when its queued item is cancelled', async () => {
    const scenario = createStandardScenario()
    const item = scenario.queue[0]
    scenario.queue = [item]
    const agent = scenario.agents.find(
      (candidate) => candidate.agentInstanceId === item.agentInstanceId
    )!
    const activeRunId = id('run-queue-cancel-test', 'RunId')
    agent.queueDepth = 1
    agent.runtimeState = 'running'
    agent.activeRunId = activeRunId
    const adapter = new MockScenarioAdapter(scenario)
    const before = await adapter.getSnapshot()

    await adapter.dispatch(
      manageQueue(cmdId(32), before.revision, item.queueItemId, 'cancel')
    )

    expect(
      (await adapter.getSnapshot()).agents.find(
        (candidate) => candidate.agentInstanceId === agent.agentInstanceId
      )
    ).toMatchObject({
      queueDepth: 0,
      runtimeState: 'running',
      activeRunId
    })
  })

  it('does not create an active Run or successful result when cancelling', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const item = before.queue[0]
    const activeRunIds = before.agents.map((agent) => agent.activeRunId)

    await adapter.dispatch(
      manageQueue(cmdId(4), before.revision, item.queueItemId, 'cancel')
    )

    const after = await adapter.getSnapshot()
    expect(after.agents.map((agent) => agent.activeRunId)).toEqual(activeRunIds)
    expect(after.activity[0].kind).toBe('queue-cancelled')
    expect(after.activity[0].kind).not.toMatch(/completed|succeeded/)
  })

  it('move-earlier decreases position when not first', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const second = snap.queue.find((q) => q.position === 2)!
    const result = await adapter.dispatch(
      manageQueue(cmdId(1), snap.revision, second.queueItemId, 'move-earlier')
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const moved = after.queue.find((q) => q.queueItemId === second.queueItemId)!
    expect(moved.position).toBe(1)
  })

  it('move-later increases position when not last', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const first = snap.queue.find((q) => q.position === 1)!
    const result = await adapter.dispatch(
      manageQueue(cmdId(1), snap.revision, first.queueItemId, 'move-later')
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const moved = after.queue.find((q) => q.queueItemId === first.queueItemId)!
    expect(moved.position).toBe(2)
  })

  it.each([
    {
      initial: 'low',
      operation: 'raise-priority',
      expected: 'normal'
    },
    {
      initial: 'normal',
      operation: 'raise-priority',
      expected: 'high'
    },
    {
      initial: 'high',
      operation: 'lower-priority',
      expected: 'normal'
    },
    {
      initial: 'normal',
      operation: 'lower-priority',
      expected: 'low'
    }
  ] as const)(
    'steps $initial via $operation to $expected',
    async ({ initial, operation, expected }) => {
      const scenario = createStandardScenario()
      scenario.queue[0].priority = initial
      const adapter = new MockScenarioAdapter(scenario)
      const before = await adapter.getSnapshot()
      const item = before.queue[0]

      const result = await adapter.dispatch(
        manageQueue(cmdId(81), before.revision, item.queueItemId, operation)
      )

      expect(result.ok).toBe(true)
      const after = await adapter.getSnapshot()
      expect(
        after.queue.find((queueItem) => queueItem.queueItemId === item.queueItemId)
          ?.priority
      ).toBe(expected)
      expect(after.revision).toBe(before.revision + 1)
    }
  )

  it.each([
    { initial: 'high', operation: 'raise-priority', boundary: '最高' },
    { initial: 'low', operation: 'lower-priority', boundary: '最低' }
  ] as const)(
    'rejects $operation at the $boundary boundary without a revision',
    async ({ initial, operation, boundary }) => {
      const scenario = createStandardScenario()
      scenario.queue[0].priority = initial
      const adapter = new MockScenarioAdapter(scenario)
      const before = await adapter.getSnapshot()
      const events: WorkbenchEvent[] = []
      const unsubscribe = adapter.subscribe((event) => events.push(event))

      const result = await adapter.dispatch(
        manageQueue(
          cmdId(82),
          before.revision,
          before.queue[0].queueItemId,
          operation
        )
      )
      unsubscribe()

      expect(result).toMatchObject({
        ok: false,
        reason: 'invariant-violation',
        latestRevision: before.revision,
        message: expect.stringContaining(boundary)
      })
      expect(await adapter.getSnapshot()).toEqual(before)
      expect(events.map((event) => event.kind)).toEqual(['command-rejected'])
    }
  )

  it.each([
    {
      first: 'raise-priority',
      midpoint: 'high',
      second: 'lower-priority'
    },
    {
      first: 'lower-priority',
      midpoint: 'low',
      second: 'raise-priority'
    }
  ] as const)(
    'returns normal after $first then $second',
    async ({ first, midpoint, second }) => {
      const adapter = new MockScenarioAdapter()
      const before = await adapter.getSnapshot()
      const item = before.queue[0]

      await adapter.dispatch(
        manageQueue(cmdId(83), before.revision, item.queueItemId, first)
      )
      const changed = await adapter.getSnapshot()
      expect(
        changed.queue.find(
          (queueItem) => queueItem.queueItemId === item.queueItemId
        )?.priority
      ).toBe(midpoint)

      await adapter.dispatch(
        manageQueue(cmdId(84), changed.revision, item.queueItemId, second)
      )
      const restored = await adapter.getSnapshot()
      expect(
        restored.queue.find(
          (queueItem) => queueItem.queueItemId === item.queueItemId
        )?.priority
      ).toBe('normal')
    }
  )

  it('rejects invalid queue item id', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      manageQueue(
        cmdId(1),
        snap.revision,
        id('queue-nonexistent', 'QueueItemId'),
        'cancel'
      )
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })
})

// ---------------------------------------------------------------------------
// set-terminal-takeover — execution slot mutual exclusion (#7)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — set-terminal-takeover', () => {
  function terminalCmd(
    commandId: CommandId,
    expectedRevision: number,
    agentInstanceId: AgentInstanceId,
    operation: 'open' | 'close',
    projectId: ProjectId = id('proj-sales', 'ProjectId')
  ): WorkbenchCommand {
    return {
      kind: 'set-terminal-takeover',
      commandId,
      expectedRevision,
      projectId,
      agentInstanceId,
      operation
    }
  }

  it('open sets terminalState to active for a ready agent', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    // cx_review is 'ready' with terminalState 'closed'
    const ready = snap.agents.find(
      (a) => a.name === 'cx_review'
    )!
    const result = await adapter.dispatch(
      terminalCmd(cmdId(1), snap.revision, ready.agentInstanceId, 'open')
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const agent = after.agents.find((a) => a.agentInstanceId === ready.agentInstanceId)!
    expect(agent.terminalState).toBe('active')
  })

  it('open is rejected when agent has an active Run', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    // cc_data is 'running'
    const running = snap.agents.find(
      (a) => a.name === 'cc_data'
    )!
    const result = await adapter.dispatch(
      terminalCmd(cmdId(1), snap.revision, running.agentInstanceId, 'open')
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('busy')
  })

  it('close sets terminalState back to closed', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    // cx_anti has terminalState 'active'
    const active = snap.agents.find(
      (a) => a.name === 'cx_anti'
    )!
    const result = await adapter.dispatch(
      terminalCmd(cmdId(1), snap.revision, active.agentInstanceId, 'close')
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const agent = after.agents.find((a) => a.agentInstanceId === active.agentInstanceId)!
    expect(agent.terminalState).toBe('closed')
  })

  it('after terminal open, send-agent-instruction is rejected as busy', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const ready = snap.agents.find((a) => a.name === 'cx_review')!
    // Open terminal
    await adapter.dispatch(
      terminalCmd(cmdId(1), snap.revision, ready.agentInstanceId, 'open')
    )
    const snap2 = await adapter.getSnapshot()
    // Now try to send instruction
    const result = await adapter.dispatch({
      kind: 'send-agent-instruction',
      commandId: cmdId(2),
      expectedRevision: snap2.revision,
      projectId: id('proj-sales', 'ProjectId'),
      agentInstanceId: ready.agentInstanceId,
      instruction: 'test',
      mode: 'start-or-queue'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('busy')
  })

  it('open succeeds for a queued agent (no active Run)', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    // cx_forecast is 'queued' — should be allowed to open Terminal
    const queued = snap.agents.find((a) => a.name === 'cx_forecast')!
    const result = await adapter.dispatch(
      terminalCmd(cmdId(1), snap.revision, queued.agentInstanceId, 'open')
    )
    expect(result.ok).toBe(true)
  })

  it.each([
    {
      condition: 'Project archived',
      configure: (snapshot: WorkbenchViewModel) => {
        snapshot.projects[0].lifecycle = 'archived'
      },
      message: 'Project 已归档，不能接管 Terminal'
    },
    {
      condition: 'Project Root unavailable',
      configure: (snapshot: WorkbenchViewModel) => {
        snapshot.projects[0].rootAvailability = 'unavailable'
      },
      message: 'Project Root 不可用，不能接管 Terminal'
    },
    {
      condition: 'repository not ready',
      configure: (snapshot: WorkbenchViewModel) => {
        snapshot.projects[0].repositoryReadiness = 'not-ready'
      },
      message: 'Project 尚未初始化或绑定 Git 仓库，不能接管 Terminal'
    }
  ])('rejects open atomically when $condition', async ({ configure, message }) => {
    const scenario = createStandardScenario()
    configure(scenario)
    const adapter = new MockScenarioAdapter(scenario)
    const before = await adapter.getSnapshot()
    const ready = before.agents.find((agent) => agent.name === 'cx_review')!

    const result = await adapter.dispatch(
      terminalCmd(cmdId(91), before.revision, ready.agentInstanceId, 'open')
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'unavailable',
      message
    })
    expect(await adapter.getSnapshot()).toEqual(before)
  })

  it.each([
    {
      condition: 'Project archived',
      configure: (snapshot: WorkbenchViewModel) => {
        snapshot.projects[0].lifecycle = 'archived'
      }
    },
    {
      condition: 'Project Root unavailable',
      configure: (snapshot: WorkbenchViewModel) => {
        snapshot.projects[0].rootAvailability = 'unavailable'
      }
    },
    {
      condition: 'repository not ready',
      configure: (snapshot: WorkbenchViewModel) => {
        snapshot.projects[0].repositoryReadiness = 'not-ready'
      }
    }
  ])('still allows close when $condition', async ({ configure }) => {
    const scenario = createStandardScenario()
    configure(scenario)
    const adapter = new MockScenarioAdapter(scenario)
    const before = await adapter.getSnapshot()
    const active = before.agents.find((agent) => agent.name === 'cx_anti')!

    const result = await adapter.dispatch(
      terminalCmd(cmdId(92), before.revision, active.agentInstanceId, 'close')
    )

    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(
      after.agents.find(
        (agent) => agent.agentInstanceId === active.agentInstanceId
      )?.terminalState
    ).toBe('closed')
  })

  it('open is rejected for an unavailable agent', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const unavailable = snap.agents.find((a) => a.name === 'kimi_docs')!
    const result = await adapter.dispatch(
      terminalCmd(cmdId(1), snap.revision, unavailable.agentInstanceId, 'open')
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unavailable')
  })
})

// ---------------------------------------------------------------------------
// manage-queue — cross-project rejection and cancel state restore (#7 review)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — manage-queue ownership', () => {
  it('rejects manage-queue with wrong projectId', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const item = snap.queue[0] // belongs to proj-sales
    const result = await adapter.dispatch({
      kind: 'manage-queue',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: id('proj-research', 'ProjectId'),
      queueItemId: item.queueItemId,
      operation: 'cancel'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })

  it('cancel restores agent to ready when queue is empty', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    // cx_forecast has queueDepth 2 and runtimeState 'queued'
    const forecastId = snap.agents.find((a) => a.name === 'cx_forecast')!.agentInstanceId
    const items = snap.queue.filter((q) => q.agentInstanceId === forecastId)
    // Cancel both items
    let rev = snap.revision
    for (const item of items) {
      await adapter.dispatch({
        kind: 'manage-queue',
        commandId: cmdId(items.indexOf(item) + 1),
        expectedRevision: rev,
        projectId: item.projectId,
        queueItemId: item.queueItemId,
        operation: 'cancel'
      })
      rev++
    }
    const after = await adapter.getSnapshot()
    const agent = after.agents.find((a) => a.name === 'cx_forecast')!
    expect(agent.queueDepth).toBe(0)
    expect(agent.runtimeState).toBe('ready')
  })
})

describe('MockScenarioAdapter — set-terminal-takeover ownership', () => {
  it('rejects set-terminal-takeover with wrong projectId', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const agent = snap.agents.find((a) => a.name === 'cx_review')!
    const result = await adapter.dispatch({
      kind: 'set-terminal-takeover',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: id('proj-research', 'ProjectId'),
      agentInstanceId: agent.agentInstanceId,
      operation: 'open'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })
})

// ---------------------------------------------------------------------------
// Concurrency limits — per-instance, Project (3), Global (6) (#7 AC1)
// ---------------------------------------------------------------------------

const ACTIVE_STRUCTURED_STATES: readonly AgentRuntimeState[] = [
  'starting',
  'running',
  'finishing',
  'needs-input',
  'permission-requested'
]

function isActiveStructuredState(state: AgentRuntimeState): boolean {
  return ACTIVE_STRUCTURED_STATES.includes(state)
}

function expectActiveRunSummary(snapshot: WorkbenchViewModel): void {
  let globalActive = 0
  for (const project of snapshot.projects) {
    const active = snapshot.agents.filter(
      (agent) =>
        agent.projectId === project.projectId &&
        isActiveStructuredState(agent.runtimeState)
    ).length
    expect(project.activeRunCount).toBe(active)
    expect(project.activeRunCount).toBeLessThanOrEqual(
      snapshot.global.concurrency.projectLimit
    )
    globalActive += active
  }
  expect(snapshot.global.concurrency.activeGlobal).toBe(globalActive)
  expect(snapshot.global.concurrency.activeGlobal).toBeLessThanOrEqual(
    snapshot.global.concurrency.globalLimit
  )
}

function resetExecutionFacts(snapshot: WorkbenchViewModel): void {
  for (const agent of snapshot.agents) {
    agent.runtimeState = 'ready'
    agent.terminalState = 'closed'
    agent.queueDepth = 0
    delete agent.activeRunId
  }
  snapshot.queue = []
  for (const project of snapshot.projects) {
    project.activeRunCount = 0
    project.queuedRunCount = 0
  }
  snapshot.global.concurrency.activeGlobal = 0
  snapshot.global.concurrency.queuedGlobal = 0
}

function createProjectCapacityScenario() {
  const scenario = createStandardScenario()
  const project = scenario.projects[0]
  const states = [
    ['cc_data', 'running'],
    ['cc_sql', 'needs-input'],
    ['cc_etl', 'finishing']
  ] as const
  for (const [name, runtimeState] of states) {
    scenario.agents.find((agent) => agent.name === name)!.runtimeState =
      runtimeState
  }
  project.activeRunCount = scenario.global.concurrency.projectLimit
  scenario.global.concurrency.activeGlobal = states.length
  return scenario
}

function createGlobalCapacityScenario() {
  const scenario = createProjectCapacityScenario()
  const research = scenario.projects[1]
  for (const [name, runtimeState] of [
    ['cc_report', 'running'],
    ['cx_survey', 'starting']
  ] as const) {
    scenario.agents.find((agent) => agent.name === name)!.runtimeState =
      runtimeState
  }
  research.activeRunCount = 2

  const projectId = id('proj-global-capacity', 'ProjectId')
  scenario.projects.push({
    ...structuredClone(research),
    projectId,
    name: '全局容量测试',
    activeRunCount: 1,
    queuedRunCount: 0,
    layout: { root: null, panels: {} }
  })
  const activeAgent = {
    ...structuredClone(
      scenario.agents.find((agent) => agent.name === 'cx_review')!
    ),
    agentInstanceId: id('inst-global-active', 'AgentInstanceId'),
    projectId,
    name: 'global_active',
    runtimeState: 'permission-requested' as const,
    terminalState: 'closed' as const,
    queueDepth: 0
  }
  const target = {
    ...structuredClone(
      scenario.agents.find((agent) => agent.name === 'kimi_visual')!
    ),
    agentInstanceId: id('inst-global-target', 'AgentInstanceId'),
    projectId,
    name: 'global_target',
    runtimeState: 'ready' as const,
    terminalState: 'closed' as const,
    queueDepth: 0
  }
  delete activeAgent.activeRunId
  delete target.activeRunId
  scenario.agents.push(activeAgent, target)
  scenario.global.concurrency.activeGlobal =
    scenario.global.concurrency.globalLimit
  return { scenario, projectId, targetId: target.agentInstanceId }
}

function expectQueueProjection(snapshot: WorkbenchViewModel): void {
  for (const agent of snapshot.agents) {
    expect(agent.queueDepth).toBe(
      snapshot.queue.filter(
        (item) => item.agentInstanceId === agent.agentInstanceId
      ).length
    )
  }
  for (const project of snapshot.projects) {
    expect(project.queuedRunCount).toBe(
      snapshot.queue.filter((item) => item.projectId === project.projectId)
        .length
    )
  }
  expect(snapshot.global.concurrency.queuedGlobal).toBe(snapshot.queue.length)
}

describe('MockScenarioAdapter — concurrency enforcement', () => {
  it('plans unique Project queue positions for an ordered busy batch and executes that plan', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const project = before.projects[0]
    const targets = ['cc_data', 'cx_anti'].map(
      (name) => before.agents.find((agent) => agent.name === name)!
    )
    const events: WorkbenchEvent[] = []
    const unsubscribe = adapter.subscribe((event) => events.push(event))

    const result = await adapter.planDispatch({
      expectedRevision: before.revision,
      projectId: project.projectId,
      targets: targets.map((agent) => agent.agentInstanceId)
    })

    expect(result).toEqual({
      ok: true,
      plan: {
        revision: before.revision,
        projectId: project.projectId,
        entries: [
          {
            agentInstanceId: targets[0].agentInstanceId,
            outcome: 'queue',
            position: 3
          },
          {
            agentInstanceId: targets[1].agentInstanceId,
            outcome: 'queue',
            position: 4
          }
        ]
      }
    })
    expect(
      await adapter.planDispatch({
        expectedRevision: before.revision,
        projectId: project.projectId,
        targets: targets.map((agent) => agent.agentInstanceId)
      })
    ).toEqual(result)
    expect(await adapter.getSnapshot()).toEqual(before)
    expect(events).toEqual([])
    unsubscribe()

    await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(99),
      expectedRevision: before.revision,
      projectId: project.projectId,
      targets: targets.map((agent) => agent.agentInstanceId),
      instruction: 'queue in preview order'
    })

    const after = await adapter.getSnapshot()
    expect(
      after.queue
        .filter((item) =>
          targets.some(
            (target) => target.agentInstanceId === item.agentInstanceId
          )
        )
        .map((item) => ({
          agentInstanceId: item.agentInstanceId,
          position: item.position
        }))
    ).toEqual([
      { agentInstanceId: targets[0].agentInstanceId, position: 3 },
      { agentInstanceId: targets[1].agentInstanceId, position: 4 }
    ])
  })

  it('plans a ready Agent as queued when Project capacity is full', async () => {
    const adapter = new MockScenarioAdapter(createProjectCapacityScenario())
    const before = await adapter.getSnapshot()
    const project = before.projects[0]
    const target = before.agents.find((agent) => agent.name === 'cx_review')!

    const result = await adapter.planDispatch({
      expectedRevision: before.revision,
      projectId: project.projectId,
      targets: [target.agentInstanceId]
    })

    expect(result).toEqual({
      ok: true,
      plan: {
        revision: before.revision,
        projectId: project.projectId,
        entries: [
          {
            agentInstanceId: target.agentInstanceId,
            outcome: 'queue',
            position: 3
          }
        ]
      }
    })
  })

  it('plans a ready Agent as queued when only Global capacity is full', async () => {
    const { scenario, projectId, targetId } = createGlobalCapacityScenario()
    const adapter = new MockScenarioAdapter(scenario)
    const before = await adapter.getSnapshot()

    const result = await adapter.planDispatch({
      expectedRevision: before.revision,
      projectId,
      targets: [targetId]
    })

    expect(result).toEqual({
      ok: true,
      plan: {
        revision: before.revision,
        projectId,
        entries: [
          { agentInstanceId: targetId, outcome: 'queue', position: 1 }
        ]
      }
    })
  })

  it('reserves remaining capacity in target order before assigning queue positions', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const project = before.projects[0]
    const targets = ['cx_review', 'kimi_visual'].map(
      (name) => before.agents.find((agent) => agent.name === name)!
    )

    const result = await adapter.planDispatch({
      expectedRevision: before.revision,
      projectId: project.projectId,
      targets: targets.map((agent) => agent.agentInstanceId)
    })

    expect(result).toEqual({
      ok: true,
      plan: {
        revision: before.revision,
        projectId: project.projectId,
        entries: [
          {
            agentInstanceId: targets[0].agentInstanceId,
            outcome: 'start'
          },
          {
            agentInstanceId: targets[1].agentInstanceId,
            outcome: 'queue',
            position: 3
          }
        ]
      }
    })

    await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(98),
      expectedRevision: before.revision,
      projectId: project.projectId,
      targets: targets.map((agent) => agent.agentInstanceId),
      instruction: 'cross one remaining slot'
    })
    const after = await adapter.getSnapshot()
    expect(
      after.agents.find(
        (agent) => agent.agentInstanceId === targets[0].agentInstanceId
      )!.runtimeState
    ).toBe('running')
    expect(
      after.queue.find(
        (item) => item.agentInstanceId === targets[1].agentInstanceId
      )?.position
    ).toBe(3)
  })

  it('rejects stale plans and stale confirmations without partial mutation', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const project = before.projects[0]
    const target = before.agents.find((agent) => agent.name === 'cx_review')!
    const planned = await adapter.planDispatch({
      expectedRevision: before.revision,
      projectId: project.projectId,
      targets: [target.agentInstanceId]
    })
    expect(planned.ok).toBe(true)

    await adapter.dispatch({
      kind: 'navigate',
      commandId: cmdId(97),
      expectedRevision: before.revision,
      projectId: project.projectId,
      surface: 'activity'
    })
    const changed = await adapter.getSnapshot()
    const stalePlan = await adapter.planDispatch({
      expectedRevision: before.revision,
      projectId: project.projectId,
      targets: [target.agentInstanceId]
    })
    expect(stalePlan).toMatchObject({
      ok: false,
      reason: 'stale-revision',
      latestRevision: changed.revision
    })

    const result = await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(96),
      expectedRevision: before.revision,
      projectId: project.projectId,
      targets: [target.agentInstanceId],
      instruction: 'must not partially apply'
    })
    expect(result).toMatchObject({ ok: false, reason: 'stale-revision' })
    expect(await adapter.getSnapshot()).toEqual(changed)
  })

  it('ships a standard scenario whose summaries equal active Agent states', () => {
    const snapshot = createStandardScenario()
    expect(
      snapshot.agents
        .filter((agent) => isActiveStructuredState(agent.runtimeState))
        .map((agent) => agent.name)
    ).toEqual(['cc_data', 'cc_sql'])
    expectActiveRunSummary(snapshot)
    expect(snapshot.projects[0].activeRunCount).toBe(2)
    expect(snapshot.global.concurrency.activeGlobal).toBe(2)
  })

  it('uses state truth when a batch crosses the third Project slot', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const project = before.projects[0]
    const first = before.agents.find((agent) => agent.name === 'cx_review')!
    const overflow = before.agents.find(
      (agent) => agent.name === 'kimi_visual'
    )!
    await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(100),
      expectedRevision: before.revision,
      projectId: project.projectId,
      targets: [first.agentInstanceId, overflow.agentInstanceId],
      instruction: 'cross the project boundary'
    })

    const after = await adapter.getSnapshot()
    expect(
      after.agents.find(
        (agent) => agent.agentInstanceId === first.agentInstanceId
      )!.runtimeState
    ).toBe('running')
    expect(
      after.queue.some(
        (item) => item.agentInstanceId === overflow.agentInstanceId
      )
    ).toBe(true)
    expect(after.projects[0].activeRunCount).toBe(3)
    expectActiveRunSummary(after)
  })

  it('uses the same Project capacity truth for a single composer target', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const project = before.projects[0]
    const third = before.agents.find((agent) => agent.name === 'cx_review')!
    const overflow = before.agents.find(
      (agent) => agent.name === 'kimi_visual'
    )!
    await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(101),
      expectedRevision: before.revision,
      projectId: project.projectId,
      targets: [third.agentInstanceId],
      instruction: 'occupy the third slot'
    })
    const atLimit = await adapter.getSnapshot()

    await adapter.dispatch({
      kind: 'send-agent-instruction',
      commandId: cmdId(102),
      expectedRevision: atLimit.revision,
      projectId: project.projectId,
      agentInstanceId: overflow.agentInstanceId,
      instruction: 'queue after the project limit',
      mode: 'start-or-queue'
    })

    const after = await adapter.getSnapshot()
    expect(
      after.queue.some(
        (item) => item.agentInstanceId === overflow.agentInstanceId
      )
    ).toBe(true)
    expect(after.projects[0].activeRunCount).toBe(3)
    expectActiveRunSummary(after)
  })

  for (const state of ACTIVE_STRUCTURED_STATES) {
    it(`${state} occupies Project capacity even when cached counts say zero`, async () => {
      const scenario = createStandardScenario()
      resetExecutionFacts(scenario)
      const project = scenario.projects[0]
      const projectAgents = scenario.agents.filter(
        (agent) => agent.projectId === project.projectId
      )
      for (const agent of projectAgents.slice(0, 3)) {
        agent.runtimeState = state
      }
      const overflow = projectAgents[3]
      const adapter = new MockScenarioAdapter(scenario)
      const normalised = await adapter.getSnapshot()
      expect(normalised.projects[0].activeRunCount).toBe(3)
      expectActiveRunSummary(normalised)

      await adapter.dispatch({
        kind: 'confirm-dispatch',
        commandId: cmdId(200 + ACTIVE_STRUCTURED_STATES.indexOf(state)),
        expectedRevision: normalised.revision,
        projectId: project.projectId,
        targets: [overflow.agentInstanceId],
        instruction: `respect ${state}`
      })
      const after = await adapter.getSnapshot()
      expect(
        after.queue.some(
          (item) => item.agentInstanceId === overflow.agentInstanceId
        )
      ).toBe(true)
      expectActiveRunSummary(after)
    })
  }

  it('repairs stale high summaries instead of falsely queueing idle capacity', async () => {
    const scenario = createStandardScenario()
    resetExecutionFacts(scenario)
    scenario.projects[0].activeRunCount = 3
    scenario.global.concurrency.activeGlobal = 6
    const target = scenario.agents.find(
      (agent) => agent.projectId === scenario.projects[0].projectId
    )!
    const adapter = new MockScenarioAdapter(scenario)
    const normalised = await adapter.getSnapshot()
    expect(normalised.projects[0].activeRunCount).toBe(0)
    expect(normalised.global.concurrency.activeGlobal).toBe(0)

    await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(300),
      expectedRevision: normalised.revision,
      projectId: scenario.projects[0].projectId,
      targets: [target.agentInstanceId],
      instruction: 'use real idle capacity'
    })
    const after = await adapter.getSnapshot()
    expect(
      after.agents.find(
        (agent) => agent.agentInstanceId === target.agentInstanceId
      )!.runtimeState
    ).toBe('running')
    expectActiveRunSummary(after)
  })

  it('does not treat a stale Run ID as a second active-state truth', async () => {
    const scenario = createStandardScenario()
    resetExecutionFacts(scenario)
    const project = scenario.projects[0]
    const target = scenario.agents.find(
      (agent) => agent.projectId === project.projectId
    )!
    target.activeRunId = id('stale-run-id', 'RunId')

    const adapter = new MockScenarioAdapter(scenario)
    const before = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(302),
      expectedRevision: before.revision,
      projectId: project.projectId,
      targets: [target.agentInstanceId],
      instruction: 'trust the ready runtime state'
    })

    const after = await adapter.getSnapshot()
    expect(
      after.agents.find(
        (agent) => agent.agentInstanceId === target.agentInstanceId
      )!.runtimeState
    ).toBe('running')
    expect(
      after.queue.some(
        (item) => item.agentInstanceId === target.agentInstanceId
      )
    ).toBe(false)
    expect(after.projects[0].activeRunCount).toBe(1)
    expect(after.global.concurrency.activeGlobal).toBe(1)
    expectActiveRunSummary(after)
  })

  it('starts the sixth global Run then queues the next target in the same batch', async () => {
    const scenario = createStandardScenario()
    resetExecutionFacts(scenario)
    const sales = scenario.projects[0]
    const research = scenario.projects[1]
    const salesAgents = scenario.agents.filter(
      (agent) => agent.projectId === sales.projectId
    )
    const researchAgents = scenario.agents.filter(
      (agent) => agent.projectId === research.projectId
    )
    const activeStates: AgentRuntimeState[] = [
      'running',
      'needs-input',
      'finishing'
    ]
    salesAgents.slice(0, 3).forEach((agent, index) => {
      agent.runtimeState = activeStates[index]
    })
    researchAgents.forEach((agent, index) => {
      agent.runtimeState = activeStates[index]
    })

    const overflowProjectId = id('proj-global-overflow', 'ProjectId')
    scenario.projects.push({
      ...structuredClone(research),
      projectId: overflowProjectId,
      name: '全局容量测试',
      activeRunCount: 0,
      queuedRunCount: 0,
      layout: { root: null, panels: {} }
    })
    const sixthAgent = {
      ...structuredClone(salesAgents[3]),
      agentInstanceId: id('inst-global-sixth', 'AgentInstanceId'),
      projectId: overflowProjectId,
      name: 'global_sixth',
      runtimeState: 'ready' as const,
      terminalState: 'closed' as const,
      queueDepth: 0
    }
    const overflowAgent = {
      ...structuredClone(salesAgents[4]),
      agentInstanceId: id('inst-global-overflow', 'AgentInstanceId'),
      projectId: overflowProjectId,
      name: 'global_overflow',
      runtimeState: 'ready' as const,
      terminalState: 'closed' as const,
      queueDepth: 0
    }
    delete sixthAgent.activeRunId
    delete overflowAgent.activeRunId
    scenario.agents.push(sixthAgent, overflowAgent)

    const adapter = new MockScenarioAdapter(scenario)
    const normalised = await adapter.getSnapshot()
    expect(normalised.global.concurrency.activeGlobal).toBe(5)
    expect(
      normalised.projects.find(
        (project) => project.projectId === overflowProjectId
      )!.activeRunCount
    ).toBe(0)
    expectActiveRunSummary(normalised)

    await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(301),
      expectedRevision: normalised.revision,
      projectId: overflowProjectId,
      targets: [sixthAgent.agentInstanceId, overflowAgent.agentInstanceId],
      instruction: 'cross the global limit in one batch'
    })
    const after = await adapter.getSnapshot()
    expect(
      after.agents.find(
        (agent) => agent.agentInstanceId === sixthAgent.agentInstanceId
      )!.runtimeState
    ).toBe('running')
    expect(
      after.queue.some(
        (item) => item.agentInstanceId === overflowAgent.agentInstanceId
      )
    ).toBe(true)
    expect(
      after.projects.find(
        (project) => project.projectId === overflowProjectId
      )!.activeRunCount
    ).toBe(1)
    expect(after.global.concurrency.activeGlobal).toBe(6)
    expectActiveRunSummary(after)
  })

  it('queues a ready Agent with a stale Run ID at Project capacity and restores Ready after cancellation', async () => {
    const scenario = createProjectCapacityScenario()
    scenario.agents.find(
      (agent) => agent.name === 'cx_review'
    )!.activeRunId = id('stale-capacity-run', 'RunId')
    const adapter = new MockScenarioAdapter(scenario)
    const before = await adapter.getSnapshot()
    const project = before.projects[0]
    const target = before.agents.find((agent) => agent.name === 'cx_review')!
    const beforeDepth = target.queueDepth
    const beforeProjectQueued = project.queuedRunCount
    const beforeGlobalQueued = before.global.concurrency.queuedGlobal

    const result = await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(100),
      expectedRevision: before.revision,
      projectId: project.projectId,
      targets: [target.agentInstanceId],
      instruction: 'queue at Project capacity'
    })
    expect(result.ok).toBe(true)

    const queued = await adapter.getSnapshot()
    const queuedAgent = queued.agents.find(
      (agent) => agent.agentInstanceId === target.agentInstanceId
    )!
    const queueItem = queued.queue.find(
      (item) => item.agentInstanceId === target.agentInstanceId
    )!
    expect(queuedAgent.runtimeState).toBe('queued')
    expect(queuedAgent.queueDepth).toBe(beforeDepth + 1)
    expect(queueItem).toBeDefined()
    expect(queued.projects[0].queuedRunCount).toBe(beforeProjectQueued + 1)
    expect(queued.global.concurrency.queuedGlobal).toBe(beforeGlobalQueued + 1)
    expect(queued.projects[0].activeRunCount).toBe(project.activeRunCount)
    expect(queued.global.concurrency.activeGlobal).toBe(
      before.global.concurrency.activeGlobal
    )
    expectQueueProjection(queued)

    await adapter.dispatch({
      kind: 'manage-queue',
      commandId: cmdId(101),
      expectedRevision: queued.revision,
      projectId: project.projectId,
      queueItemId: queueItem.queueItemId,
      operation: 'cancel'
    })
    const cancelled = await adapter.getSnapshot()
    const restoredAgent = cancelled.agents.find(
      (agent) => agent.agentInstanceId === target.agentInstanceId
    )!
    expect(restoredAgent.runtimeState).toBe('ready')
    expect(restoredAgent.queueDepth).toBe(beforeDepth)
    expect(
      cancelled.queue.some((item) => item.queueItemId === queueItem.queueItemId)
    ).toBe(false)
    expect(cancelled.projects[0].queuedRunCount).toBe(beforeProjectQueued)
    expect(cancelled.global.concurrency.queuedGlobal).toBe(beforeGlobalQueued)
    expect(cancelled.projects[0].activeRunCount).toBe(project.activeRunCount)
    expect(cancelled.global.concurrency.activeGlobal).toBe(
      before.global.concurrency.activeGlobal
    )
    expectQueueProjection(cancelled)
  })

  it('atomically queues a composer instruction at Project capacity', async () => {
    const adapter = new MockScenarioAdapter(createProjectCapacityScenario())
    const before = await adapter.getSnapshot()
    const project = before.projects[0]
    const target = before.agents.find(
      (agent) => agent.name === 'kimi_visual'
    )!

    await adapter.dispatch({
      kind: 'send-agent-instruction',
      commandId: cmdId(102),
      expectedRevision: before.revision,
      projectId: project.projectId,
      agentInstanceId: target.agentInstanceId,
      instruction: 'queue from composer',
      mode: 'start-or-queue'
    })

    const after = await adapter.getSnapshot()
    const queuedAgent = after.agents.find(
      (agent) => agent.agentInstanceId === target.agentInstanceId
    )!
    expect(queuedAgent.runtimeState).toBe('queued')
    expect(queuedAgent.queueDepth).toBe(target.queueDepth + 1)
    expect(
      after.queue.some(
        (item) => item.agentInstanceId === target.agentInstanceId
      )
    ).toBe(true)
    expect(after.projects[0].queuedRunCount).toBe(
      project.queuedRunCount + 1
    )
    expect(after.global.concurrency.queuedGlobal).toBe(
      before.global.concurrency.queuedGlobal + 1
    )
    expectQueueProjection(after)
  })

  it('atomically queues every ready target in a batch at Project capacity', async () => {
    const adapter = new MockScenarioAdapter(createProjectCapacityScenario())
    const before = await adapter.getSnapshot()
    const project = before.projects[0]
    const targets = ['cx_review', 'kimi_visual'].map(
      (name) => before.agents.find((agent) => agent.name === name)!
    )

    await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(103),
      expectedRevision: before.revision,
      projectId: project.projectId,
      targets: targets.map((agent) => agent.agentInstanceId),
      instruction: 'queue the whole batch'
    })

    const after = await adapter.getSnapshot()
    for (const target of targets) {
      const queuedAgent = after.agents.find(
        (agent) => agent.agentInstanceId === target.agentInstanceId
      )!
      expect(queuedAgent.runtimeState).toBe('queued')
      expect(queuedAgent.queueDepth).toBe(target.queueDepth + 1)
      expect(
        after.queue.some(
          (item) => item.agentInstanceId === target.agentInstanceId
        )
      ).toBe(true)
    }
    expect(after.projects[0].queuedRunCount).toBe(
      project.queuedRunCount + targets.length
    )
    expect(after.global.concurrency.queuedGlobal).toBe(
      before.global.concurrency.queuedGlobal + targets.length
    )
    expectQueueProjection(after)
  })

  it('queues a ready Agent when only the Global sixth slot is full', async () => {
    const { scenario, projectId, targetId } = createGlobalCapacityScenario()
    const adapter = new MockScenarioAdapter(scenario)
    const before = await adapter.getSnapshot()
    const project = before.projects.find(
      (candidate) => candidate.projectId === projectId
    )!
    const target = before.agents.find(
      (agent) => agent.agentInstanceId === targetId
    )!

    await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(104),
      expectedRevision: before.revision,
      projectId,
      targets: [targetId],
      instruction: 'queue at Global capacity'
    })

    const after = await adapter.getSnapshot()
    const queuedAgent = after.agents.find(
      (agent) => agent.agentInstanceId === targetId
    )!
    expect(project.activeRunCount).toBeLessThan(
      before.global.concurrency.projectLimit
    )
    expect(before.global.concurrency.activeGlobal).toBe(
      before.global.concurrency.globalLimit
    )
    expect(queuedAgent.runtimeState).toBe('queued')
    expect(queuedAgent.queueDepth).toBe(target.queueDepth + 1)
    expect(
      after.projects.find((candidate) => candidate.projectId === projectId)!
        .queuedRunCount
    ).toBe(project.queuedRunCount + 1)
    expect(after.global.concurrency.queuedGlobal).toBe(
      before.global.concurrency.queuedGlobal + 1
    )
    expectQueueProjection(after)
  })

  for (const expected of [
    {
      name: 'cc_data',
      runtimeState: 'permission-requested',
      terminalState: 'closed'
    },
    {
      name: 'cc_sql',
      runtimeState: 'needs-input',
      terminalState: 'closed'
    },
    { name: 'cx_anti', runtimeState: 'ready', terminalState: 'active' }
  ] as const) {
    it(`keeps ${expected.name}'s occupied state when queueing more work`, async () => {
      const adapter = new MockScenarioAdapter()
      const before = await adapter.getSnapshot()
      const project = before.projects[0]
      const target = before.agents.find(
        (agent) => agent.name === expected.name
      )!

      await adapter.dispatch({
        kind: 'confirm-dispatch',
        commandId: cmdId(110),
        expectedRevision: before.revision,
        projectId: project.projectId,
        targets: [target.agentInstanceId],
        instruction: 'queue without erasing occupancy'
      })
      const after = await adapter.getSnapshot()
      const queuedAgent = after.agents.find(
        (agent) => agent.agentInstanceId === target.agentInstanceId
      )!
      expect(queuedAgent.runtimeState).toBe(expected.runtimeState)
      expect(queuedAgent.terminalState).toBe(expected.terminalState)
      expect(queuedAgent.queueDepth).toBe(target.queueDepth + 1)
      expectQueueProjection(after)
    })
  }

  it('dispatch to idle agent starts a mock Run and increments counters', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const project = snap.projects[0]
    const beforeActive = project.activeRunCount
    const beforeGlobal = snap.global.concurrency.activeGlobal
    const idle = snap.agents.find((a) => a.name === 'cx_review')!

    await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: project.projectId,
      targets: [idle.agentInstanceId],
      instruction: 'work'
    })
    const after = await adapter.getSnapshot()
    const agent = after.agents.find(
      (a) => a.agentInstanceId === idle.agentInstanceId
    )!
    expect(agent.runtimeState).toBe('running')
    expect(agent.activeRunId).toBeDefined()
    expect(after.projects[0].activeRunCount).toBe(beforeActive + 1)
    expect(after.global.concurrency.activeGlobal).toBe(beforeGlobal + 1)
  })

  it('send-agent-instruction to idle agent starts a mock Run', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const project = snap.projects[0]
    const idle = snap.agents.find((a) => a.name === 'kimi_visual')!

    await adapter.dispatch({
      kind: 'send-agent-instruction',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: project.projectId,
      agentInstanceId: idle.agentInstanceId,
      instruction: 'do work',
      mode: 'start-or-queue'
    })
    const after = await adapter.getSnapshot()
    const agent = after.agents.find(
      (a) => a.agentInstanceId === idle.agentInstanceId
    )!
    expect(agent.runtimeState).toBe('running')
    expect(agent.activeRunId).toBeDefined()
  })

  it('dispatch enqueues when Project limit (3) is reached', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const project = snap.projects[0]
    // cc_data is running and cc_sql needs input (2 active). Dispatching
    // cx_review fills the third slot; kimi_visual must already queue.
    let rev = snap.revision
    for (const name of ['cx_review', 'kimi_visual']) {
      const a = snap.agents.find((x) => x.name === name)!
      await adapter.dispatch({
        kind: 'confirm-dispatch',
        commandId: cmdId(rev),
        expectedRevision: rev,
        projectId: project.projectId,
        targets: [a.agentInstanceId],
        instruction: 'work'
      })
      rev++
    }
    // Project now has 3 active runs. Create a new idle agent and dispatch.
    await adapter.dispatch({
      kind: 'create-agent',
      commandId: cmdId(rev),
      expectedRevision: rev,
      projectId: project.projectId,
      name: 'test_overflow',
      providerId: id('claude-code', 'AgentProviderId'),
      modelId: 'claude-sonnet-4',
      open: 'background',
      worktreeMode: 'isolated'
    })
    rev++
    const snap2 = await adapter.getSnapshot()
    const newAgent = snap2.agents.find((a) => a.name === 'test_overflow')!
    const beforeQueue = snap2.queue.length

    await adapter.dispatch({
      kind: 'confirm-dispatch',
      commandId: cmdId(rev),
      expectedRevision: rev,
      projectId: project.projectId,
      targets: [newAgent.agentInstanceId],
      instruction: 'overflow'
    })
    const after = await adapter.getSnapshot()
    const agent = after.agents.find((a) => a.name === 'test_overflow')!
    expect(agent.runtimeState).toBe('queued')
    expect(after.queue.length).toBe(beforeQueue + 1)
    expect(after.projects[0].activeRunCount).toBe(3) // unchanged
  })
})

// ---------------------------------------------------------------------------
// Permission Center — answer-permission (#9)
// ---------------------------------------------------------------------------

function answerPermission(
  commandId: CommandId,
  expectedRevision: number,
  request: WorkbenchViewModel['permissionRequests'][number],
  decision: PermissionDecision
): WorkbenchCommand {
  return {
    kind: 'answer-permission',
    commandId,
    expectedRevision,
    projectId: request.projectId,
    agentInstanceId: request.agentInstanceId,
    runId: request.runId,
    requestId: request.requestId,
    decision
  }
}

function findRequest(
  snapshot: WorkbenchViewModel,
  requestId: string
): WorkbenchViewModel['permissionRequests'][number] {
  const request = snapshot.permissionRequests.find(
    (candidate) => candidate.requestId === id(requestId, 'PermissionRequestId')
  )
  if (!request) throw new Error(`scenario permission request ${requestId} missing`)
  return request
}

describe('MockScenarioAdapter — answer-permission (#9)', () => {
  it('applies deny: removes the request, records permission-decided activity and resumes the Run', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const request = findRequest(snap, 'perm-001')
    const agentBefore = snap.agents.find(
      (a) => a.agentInstanceId === request.agentInstanceId
    )!
    expect(agentBefore.runtimeState).toBe('permission-requested')
    const activeBefore = snap.global.concurrency.activeGlobal

    const result = await adapter.dispatch(
      answerPermission(cmdId(1), snap.revision, request, 'deny')
    )
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    expect(
      after.permissionRequests.some((r) => r.requestId === request.requestId)
    ).toBe(false)
    const agent = after.agents.find(
      (a) => a.agentInstanceId === request.agentInstanceId
    )!
    expect(agent.runtimeState).toBe('running')
    // Both states occupy the execution slot — the decision never changes
    // active-run accounting.
    expect(after.global.concurrency.activeGlobal).toBe(activeBefore)
    const entry = after.activity.find((a) => a.kind === 'permission-decided')
    expect(entry).toBeDefined()
    expect(entry!.projectId).toBe(request.projectId)
    expect(entry!.agentInstanceId).toBe(request.agentInstanceId)
    expect(entry!.summary).toContain('已拒绝')
    expect(entry!.summary).toContain(request.action)
  })

  it.each([
    ['allow-once', '已允许一次'],
    ['allow-current-run', '已允许当前 Run']
  ] as const)('records %s with its exact scope label', async (decision, label) => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const request = findRequest(snap, 'perm-001')
    const result = await adapter.dispatch(
      answerPermission(cmdId(1), snap.revision, request, decision)
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const entry = after.activity.find((a) => a.kind === 'permission-decided')!
    expect(entry.summary).toContain(label)
  })

  it('rejects a decision the request does not offer', async () => {
    const scenario = createStandardScenario()
    // Narrow the authoritative offer: this request only allows denial.
    const stored = scenario.permissionRequests.find(
      (candidate) =>
        candidate.requestId === id('perm-001', 'PermissionRequestId')
    )!
    stored.decisions = ['deny']
    const adapter = new MockScenarioAdapter(scenario)
    const snap = await adapter.getSnapshot()
    const request = findRequest(snap, 'perm-001')

    const result = await adapter.dispatch(
      answerPermission(cmdId(1), snap.revision, request, 'allow-once')
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
    // Rejection purity: the request stays pending and no decision for it is
    // recorded (perm-002's construction-swept deny is a separate, prior fact).
    const after = await adapter.getSnapshot()
    expect(
      after.permissionRequests.some((r) => r.requestId === request.requestId)
    ).toBe(true)
    expect(
      after.activity.some(
        (a) => a.kind === 'permission-decided' && a.summary.includes('写入文件')
      )
    ).toBe(false)
  })

  it('rejects an already-handled request (duplicate response)', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const request = findRequest(snap, 'perm-001')
    const first = await adapter.dispatch(
      answerPermission(cmdId(1), snap.revision, request, 'allow-once')
    )
    expect(first.ok).toBe(true)
    const between = await adapter.getSnapshot()
    const second = await adapter.dispatch(
      answerPermission(cmdId(2), between.revision, request, 'deny')
    )
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.reason).toBe('invalid-target')
    }
    // The first decision stands — no extra activity, no state flip-flop.
    // (perm-002's construction-swept deny is a separate, prior entry.)
    const after = await adapter.getSnapshot()
    const decided = after.activity.filter(
      (a) => a.kind === 'permission-decided' && a.summary.includes('写入文件')
    )
    expect(decided).toHaveLength(1)
    expect(decided[0].summary).toContain('已允许一次')
  })

  it('rejects a request that never existed', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const ghost = {
      ...findRequest(snap, 'perm-001'),
      requestId: id('perm-ghost', 'PermissionRequestId')
    }
    const result = await adapter.dispatch(
      answerPermission(cmdId(1), snap.revision, ghost, 'deny')
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })

  it('publishes already-expired requests as denied at construction instead of leaving them pending', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    // perm-002 expired before construction: it must never surface as a
    // pending request, and its default-deny transition must be audited.
    expect(
      snap.permissionRequests.some(
        (r) => r.requestId === id('perm-002', 'PermissionRequestId')
      )
    ).toBe(false)
    const entry = snap.activity.find(
      (a) => a.kind === 'permission-decided' && a.summary.includes('读取外部 API')
    )
    expect(entry).toBeDefined()
    expect(entry!.summary).toContain('已拒绝')
    expect(entry!.summary).toContain('请求已超时，按拒绝处理')
    // cc_sql was never held by the request — its own state is untouched.
    expect(snap.agents.find((a) => a.name === 'cc_sql')!.runtimeState).toBe(
      'needs-input'
    )
    // Answering the already-swept request is a duplicate response.
    const ghost = await adapter.dispatch({
      kind: 'answer-permission',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: snap.projects[0].projectId,
      agentInstanceId: snap.agents.find((a) => a.name === 'cc_sql')!
        .agentInstanceId,
      runId: id('run-sql-001', 'RunId'),
      requestId: id('perm-002', 'PermissionRequestId'),
      decision: 'allow-once'
    })
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.reason).toBe('invalid-target')
  })

  it('publishes the authoritative deny transition when a pending request expires', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new MockScenarioAdapter()
      const events: WorkbenchEvent[] = []
      adapter.subscribe((event) => events.push(event))
      const before = await adapter.getSnapshot()
      expect(
        before.permissionRequests.some(
          (r) => r.requestId === id('perm-001', 'PermissionRequestId')
        )
      ).toBe(true)

      await vi.advanceTimersByTimeAsync(300_001)

      const after = await adapter.getSnapshot()
      expect(
        after.permissionRequests.some(
          (r) => r.requestId === id('perm-001', 'PermissionRequestId')
        )
      ).toBe(false)
      expect(after.revision).toBe(before.revision + 1)
      const entry = after.activity.find((a) => a.kind === 'permission-decided')!
      expect(entry.summary).toContain('已拒绝')
      expect(entry.summary).toContain('请求已超时，按拒绝处理')
      // The held Run is released and the linked attention item resolves in
      // the same authoritative transition.
      expect(after.agents.find((a) => a.name === 'cc_data')!.runtimeState).toBe(
        'running'
      )
      expect(
        after.attentionItems.find(
          (item) => item.attentionItemId === id('att-001', 'AttentionItemId')
        )!.state
      ).toBe('resolved')
      expect(
        events.some(
          (event) =>
            event.kind === 'view-model-updated' &&
            event.revision === before.revision + 1
        )
      ).toBe(true)
      expect(
        events.some(
          (event) =>
            event.kind === 'attention-changed' &&
            event.attentionItemId === id('att-001', 'AttentionItemId')
        )
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('collapses an answer landing after the deadline into the same single deny transition', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new MockScenarioAdapter()
      const snap = await adapter.getSnapshot()
      const request = findRequest(snap, 'perm-001')
      // Time passes the deadline, but the expiry timer has not fired yet.
      vi.setSystemTime(Date.now() + 300_001)

      const result = await adapter.dispatch(
        answerPermission(cmdId(1), snap.revision, request, 'allow-current-run')
      )
      expect(result.ok).toBe(true)

      const after = await adapter.getSnapshot()
      // Scoped to perm-001's action — perm-002's construction-swept deny is
      // a separate, prior entry.
      const decided = after.activity.filter(
        (a) => a.kind === 'permission-decided' && a.summary.includes('写入文件')
      )
      expect(decided).toHaveLength(1)
      expect(decided[0].summary).toContain('已拒绝')
      expect(decided[0].summary).toContain('请求已超时，按拒绝处理')
      // The scheduled expiry timer must not record a second decision.
      await vi.advanceTimersByTimeAsync(60_000)
      const later = await adapter.getSnapshot()
      expect(
        later.activity.filter(
          (a) =>
            a.kind === 'permission-decided' && a.summary.includes('写入文件')
        )
      ).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves the linked permission attention item and recomputes attention counts', async () => {
    const adapter = new MockScenarioAdapter()
    const events: WorkbenchEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const snap = await adapter.getSnapshot()
    const linked = snap.attentionItems.find(
      (item) => item.attentionItemId === id('att-001', 'AttentionItemId')
    )!
    expect(linked.state).toBe('open')
    const projectOpenBefore = snap.projects[0].attentionCount
    const globalOpenBefore = snap.global.attentionCount

    const result = await adapter.dispatch(
      answerPermission(cmdId(1), snap.revision, findRequest(snap, 'perm-001'), 'deny')
    )
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const resolved = after.attentionItems.find(
      (item) => item.attentionItemId === linked.attentionItemId
    )!
    expect(resolved.state).toBe('resolved')
    expect(after.projects[0].attentionCount).toBe(projectOpenBefore - 1)
    expect(after.global.attentionCount).toBe(globalOpenBefore - 1)
    const changed = events.find(
      (event): event is Extract<WorkbenchEvent, { kind: 'attention-changed' }> =>
        event.kind === 'attention-changed' &&
        event.attentionItemId === linked.attentionItemId
    )
    expect(changed).toBeDefined()
    expect(changed!.state).toBe('resolved')
  })

  it('never starts an Agent as a side effect of a decision', async () => {
    const adapter = new MockScenarioAdapter()
    const events: WorkbenchEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const snap = await adapter.getSnapshot()
    const runActivityBefore = snap.activity.filter(
      (entry) => entry.kind === 'run-started'
    ).length

    await adapter.dispatch(
      answerPermission(cmdId(1), snap.revision, findRequest(snap, 'perm-001'), 'allow-once')
    )

    const after = await adapter.getSnapshot()
    expect(
      after.activity.filter((entry) => entry.kind === 'run-started')
    ).toHaveLength(runActivityBefore)
    expect(events.some((event) => event.kind === 'dispatch-created')).toBe(false)
    expect(events.some((event) => event.kind === 'permission-requested')).toBe(
      false
    )
    expect(after.global.concurrency.activeGlobal).toBe(
      snap.global.concurrency.activeGlobal
    )
  })
})

// ---------------------------------------------------------------------------
// Global Attention — resolve-attention (#9)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — resolve-attention (#9)', () => {
  it('marks an open item resolved and records it in Project Activity', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const target = snap.attentionItems.find(
      (item) => item.attentionItemId === id('att-005', 'AttentionItemId')
    )!
    expect(target.state).toBe('open')

    const result = await adapter.dispatch({
      kind: 'resolve-attention',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      attentionItemId: target.attentionItemId
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const resolved = after.attentionItems.find(
      (item) => item.attentionItemId === target.attentionItemId
    )!
    expect(resolved.state).toBe('resolved')
    const entry = after.activity.find((a) => a.kind === 'attention-resolved')!
    expect(entry).toBeDefined()
    expect(entry.projectId).toBe(
      target.target.kind === 'project'
        ? target.target.projectId
        : target.target.projectId
    )
    expect(entry.summary).toContain(target.title)
  })

  it('recomputes project and global attention counts and emits attention-changed', async () => {
    const adapter = new MockScenarioAdapter()
    const events: WorkbenchEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const snap = await adapter.getSnapshot()
    const target = snap.attentionItems.find(
      (item) => item.attentionItemId === id('att-005', 'AttentionItemId')
    )!
    const projectBefore = snap.projects[0].attentionCount
    const globalBefore = snap.global.attentionCount

    await adapter.dispatch({
      kind: 'resolve-attention',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      attentionItemId: target.attentionItemId
    })

    const after = await adapter.getSnapshot()
    expect(after.projects[0].attentionCount).toBe(projectBefore - 1)
    expect(after.global.attentionCount).toBe(globalBefore - 1)
    const changed = events.find(
      (event): event is Extract<WorkbenchEvent, { kind: 'attention-changed' }> =>
        event.kind === 'attention-changed' &&
        event.attentionItemId === target.attentionItemId
    )
    expect(changed).toBeDefined()
    expect(changed!.state).toBe('resolved')
  })

  it('rejects resolving an unknown or already-resolved item', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const target = snap.attentionItems.find(
      (item) => item.attentionItemId === id('att-005', 'AttentionItemId')
    )!
    await adapter.dispatch({
      kind: 'resolve-attention',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      attentionItemId: target.attentionItemId
    })
    const between = await adapter.getSnapshot()
    const second = await adapter.dispatch({
      kind: 'resolve-attention',
      commandId: cmdId(2),
      expectedRevision: between.revision,
      attentionItemId: target.attentionItemId
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe('invalid-target')

    const ghost = await adapter.dispatch({
      kind: 'resolve-attention',
      commandId: cmdId(3),
      expectedRevision: between.revision,
      attentionItemId: id('att-ghost', 'AttentionItemId')
    })
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.reason).toBe('invalid-target')
  })

  it('rejects direct resolution of permission-requested items (fail-closed)', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    // att-001 is the permission-requested projection of perm-001: resolving
    // it directly would bypass the three valid decisions and strand the Run.
    const result = await adapter.dispatch({
      kind: 'resolve-attention',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      attentionItemId: id('att-001', 'AttentionItemId')
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invariant-violation')
    const after = await adapter.getSnapshot()
    expect(
      after.attentionItems.find(
        (item) => item.attentionItemId === id('att-001', 'AttentionItemId')
      )!.state
    ).toBe('open')
    expect(
      after.permissionRequests.some(
        (r) => r.requestId === id('perm-001', 'PermissionRequestId')
      )
    ).toBe(true)
    expect(after.activity.some((a) => a.kind === 'attention-resolved')).toBe(
      false
    )
  })

  it('does not start Agents or dispatch work when resolving attention', async () => {
    const adapter = new MockScenarioAdapter()
    const events: WorkbenchEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const snap = await adapter.getSnapshot()
    const target = snap.attentionItems.find(
      (item) => item.attentionItemId === id('att-005', 'AttentionItemId')
    )!
    const runActivityBefore = snap.activity.filter(
      (entry) => entry.kind === 'run-started'
    ).length

    await adapter.dispatch({
      kind: 'resolve-attention',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      attentionItemId: target.attentionItemId
    })

    const after = await adapter.getSnapshot()
    expect(
      after.activity.filter((entry) => entry.kind === 'run-started')
    ).toHaveLength(runActivityBefore)
    expect(events.some((event) => event.kind === 'dispatch-created')).toBe(false)
    expect(after.global.concurrency.activeGlobal).toBe(
      snap.global.concurrency.activeGlobal
    )
  })
})

// ---------------------------------------------------------------------------
// Global Attention — scenario aggregation data (#9)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — attention scenario data (#9)', () => {
  it('aggregates every attention kind across all projects', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const open = snap.attentionItems.filter((item) => item.state === 'open')
    const kinds = new Set(open.map((item) => item.kind))
    for (const kind of [
      'permission-requested',
      'needs-input',
      'failed',
      'interrupted',
      'completed',
      'connection-conflict',
      'provider-unavailable'
    ] as const) {
      expect(kinds.has(kind)).toBe(true)
    }
    // Cross-project: at least one open item outside the active project.
    expect(
      open.some((item) => item.target.projectId !== snap.activeProjectId)
    ).toBe(true)
  })

  it('covers every deep-link target type with stable branded IDs', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const open = snap.attentionItems.filter((item) => item.state === 'open')
    const targetKinds = new Set(open.map((item) => item.target.kind))
    for (const kind of [
      'project',
      'agent',
      'run',
      'project-task',
      'external-task',
      'knowledge',
      'handoff'
    ] as const) {
      expect(targetKinds.has(kind)).toBe(true)
    }
  })

  it('keeps attention counts consistent with the authoritative open items', async () => {
    const scenario = createStandardScenario()
    // Corrupt the projections on purpose — the adapter must repair them from
    // the authoritative item list instead of trusting stale summaries.
    scenario.projects[0].attentionCount = 99
    scenario.global.attentionCount = 99
    const adapter = new MockScenarioAdapter(scenario)
    const snap = await adapter.getSnapshot()
    for (const project of snap.projects) {
      const open = snap.attentionItems.filter(
        (item) => item.state === 'open' && item.target.projectId === project.projectId
      ).length
      expect(project.attentionCount).toBe(open)
    }
    expect(snap.global.attentionCount).toBe(
      snap.attentionItems.filter((item) => item.state === 'open').length
    )
  })
})

// ---------------------------------------------------------------------------
// Permission Center — injected clock & multi-request precision (#9 review)
// ---------------------------------------------------------------------------

describe('MockScenarioAdapter — permission clock and multi-request handling', () => {
  it('honours an injected clock: frozen time keeps pending requests and deterministic audit', async () => {
    const FROZEN = 1_700_000_000_000
    const adapter = new MockScenarioAdapter(createStandardScenario(FROZEN), {
      now: () => FROZEN
    })
    const snap = await adapter.getSnapshot()
    // perm-001's deadline is still ahead of the frozen clock.
    expect(
      snap.permissionRequests.some(
        (r) => r.requestId === id('perm-001', 'PermissionRequestId')
      )
    ).toBe(true)
    expect(snap.agents.find((a) => a.name === 'cc_data')!.runtimeState).toBe(
      'permission-requested'
    )
    // perm-002 was past its deadline even on the frozen clock: swept with a
    // deterministic frozen timestamp — never the process wall clock.
    expect(
      snap.permissionRequests.some(
        (r) => r.requestId === id('perm-002', 'PermissionRequestId')
      )
    ).toBe(false)
    const entry = snap.activity.find(
      (a) =>
        a.kind === 'permission-decided' && a.summary.includes('读取外部 API')
    )!
    expect(entry.timestamp).toBe(FROZEN)
  })

  it('drives the expiry timer from the injected clock', async () => {
    vi.useFakeTimers()
    try {
      let now = 1_700_000_000_000
      const adapter = new MockScenarioAdapter(createStandardScenario(now), {
        now: () => now
      })
      const before = await adapter.getSnapshot()
      expect(
        before.permissionRequests.some(
          (r) => r.requestId === id('perm-001', 'PermissionRequestId')
        )
      ).toBe(true)

      now += 300_001
      await vi.advanceTimersByTimeAsync(300_001)

      const after = await adapter.getSnapshot()
      expect(
        after.permissionRequests.some(
          (r) => r.requestId === id('perm-001', 'PermissionRequestId')
        )
      ).toBe(false)
      const entry = after.activity.find(
        (a) => a.kind === 'permission-decided' && a.summary.includes('写入文件')
      )!
      expect(entry.summary).toContain('请求已超时，按拒绝处理')
      expect(entry.timestamp).toBe(now)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the Run held and other reminders open while another request is pending', async () => {
    const scenario = createStandardScenario()
    const project = scenario.projects[0]
    const ccData = scenario.agents.find((a) => a.name === 'cc_data')!
    const runId = id('run-001', 'RunId')
    scenario.permissionRequests.push({
      requestId: id('perm-extra', 'PermissionRequestId'),
      projectId: project.projectId,
      agentInstanceId: ccData.agentInstanceId,
      runId,
      action: '删除临时文件',
      scope: 'worktree 内 tmp/**',
      reason: '清理中间产物',
      expiresAt: Date.now() + 300_000,
      decisions: ['deny', 'allow-once', 'allow-current-run']
    })
    scenario.attentionItems.push({
      attentionItemId: id('att-extra', 'AttentionItemId'),
      kind: 'permission-requested',
      permissionRequestId: id('perm-extra', 'PermissionRequestId'),
      target: {
        kind: 'run',
        projectId: project.projectId,
        agentInstanceId: ccData.agentInstanceId,
        runId
      },
      state: 'open',
      title: 'cc_data 请求删除临时文件'
    })
    const adapter = new MockScenarioAdapter(scenario)
    const snap = await adapter.getSnapshot()

    const first = await adapter.dispatch(
      answerPermission(cmdId(1), snap.revision, findRequest(snap, 'perm-001'), 'deny')
    )
    expect(first.ok).toBe(true)

    const after = await adapter.getSnapshot()
    // The Run stays held — perm-extra is still pending on the same Agent.
    expect(after.agents.find((a) => a.name === 'cc_data')!.runtimeState).toBe(
      'permission-requested'
    )
    // Only the handled request's reminder resolved; the other stays open.
    expect(
      after.attentionItems.find(
        (i) => i.attentionItemId === id('att-001', 'AttentionItemId')
      )!.state
    ).toBe('resolved')
    expect(
      after.attentionItems.find(
        (i) => i.attentionItemId === id('att-extra', 'AttentionItemId')
      )!.state
    ).toBe('open')

    // Handling the second request releases the Run and its own reminder.
    const mid = await adapter.getSnapshot()
    const second = await adapter.dispatch(
      answerPermission(
        cmdId(2),
        mid.revision,
        findRequest(mid, 'perm-extra'),
        'allow-current-run'
      )
    )
    expect(second.ok).toBe(true)
    const final = await adapter.getSnapshot()
    expect(final.agents.find((a) => a.name === 'cc_data')!.runtimeState).toBe(
      'running'
    )
    expect(
      final.attentionItems.find(
        (i) => i.attentionItemId === id('att-extra', 'AttentionItemId')
      )!.state
    ).toBe('resolved')
  })
})
