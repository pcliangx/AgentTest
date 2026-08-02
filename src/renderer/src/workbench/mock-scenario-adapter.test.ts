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
      open: 'current-panel' | 'background'
    }> = {}
  ): WorkbenchCommand {
    return {
      kind: 'create-agent',
      commandId,
      expectedRevision,
      projectId: overrides.projectId ?? DEFAULT_PROJECT_ID,
      name: overrides.name ?? 'cc_new',
      providerId: id(overrides.providerId ?? 'claude-code', 'AgentProviderId'),
      open: overrides.open ?? 'current-panel'
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
    expect(ccData.runtimeState).toBe('running')
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
    // The instance survives with its run untouched.
    const ccData = after.agents.find((a) => a.agentInstanceId === CC_DATA)!
    expect(ccData.runtimeState).toBe('running')
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

  it('still rejects split-tree operations as scenario-read-only (out of scope)', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      changeLayout(cmdId(1), snap.revision, {
        kind: 'split-panel',
        panelId: PANEL,
        direction: 'horizontal'
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('scenario-read-only')
  })
})
