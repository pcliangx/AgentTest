import { describe, it, expect } from 'vitest'
import { MockScenarioAdapter } from './mock-scenario-adapter'
import { id } from './contract'
import type {
  AgentProviderId,
  CommandId,
  CommandResult,
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

  it('still rejects focus operations as scenario-read-only (#5 scope)', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const result = await adapter.dispatch(
      changeLayout(cmdId(1), snap.revision, {
        kind: 'focus-panel',
        panelId: PANEL
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('scenario-read-only')
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
