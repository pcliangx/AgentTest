import { describe, it, expect } from 'vitest'
import { MockScenarioAdapter } from './mock-scenario-adapter'
import { id } from './contract'
import type {
  CommandId,
  ConfigurationOwner,
  WorkbenchCommand,
  WorkbenchCommandBody,
  WorkbenchEvent,
  WorkbenchViewModel
} from './contract'

/**
 * Configuration domain tests (#13) — stage / discard / atomic apply through
 * the WorkbenchPort seam. The mock adapter owns the field catalogue and
 * validation; the renderer only ever sees adapter-judged facts.
 */

const PROJECT = id('proj-sales', 'ProjectId')
const CC_DATA = id('inst-cc-data', 'AgentInstanceId')
const CC_SQL = id('inst-cc-sql', 'AgentInstanceId')
const CONN_PRIMARY = id('conn-feishu-primary', 'ConnectionId')
const CONN_PRODUCT = id('conn-feishu-product', 'ConnectionId')

const projectOwner: ConfigurationOwner = { kind: 'project', projectId: PROJECT }
const ccDataOwner: ConfigurationOwner = {
  kind: 'agent',
  agentInstanceId: CC_DATA
}
const ccSqlOwner: ConfigurationOwner = { kind: 'agent', agentInstanceId: CC_SQL }

let commandCounter = 0
function cmd(): CommandId {
  return id(`cmd-cfg-${++commandCounter}`, 'CommandId')
}

async function send(
  adapter: MockScenarioAdapter,
  body: WorkbenchCommandBody
): Promise<ReturnType<MockScenarioAdapter['dispatch']>> {
  const snap = await adapter.getSnapshot()
  return adapter.dispatch({
    ...body,
    commandId: cmd(),
    expectedRevision: snap.revision
  } as WorkbenchCommand)
}

function stage(
  adapter: MockScenarioAdapter,
  owner: ConfigurationOwner,
  fieldPath: string,
  value: unknown
) {
  return send(adapter, { kind: 'stage-configuration', owner, fieldPath, value })
}

function appliedOf(
  snap: WorkbenchViewModel,
  owner: ConfigurationOwner
): { appliedVersion: number; values: Record<string, unknown> } {
  const key = ownerKey(owner)
  const entry = snap.appliedConfigurations.find((c) => ownerKey(c.owner) === key)
  if (!entry) throw new Error(`no applied configuration for ${key}`)
  return entry
}

function draftOf(snap: WorkbenchViewModel, owner: ConfigurationOwner) {
  const key = ownerKey(owner)
  return snap.configurationDrafts.find((d) => ownerKey(d.owner) === key)
}

function ownerKey(owner: ConfigurationOwner): string {
  return owner.kind === 'project'
    ? `project:${owner.projectId}`
    : `agent:${owner.agentInstanceId}`
}

async function applyAll(adapter: MockScenarioAdapter, owners: ConfigurationOwner[]) {
  const snap = await adapter.getSnapshot()
  return send(adapter, {
    kind: 'apply-configuration',
    owners: owners.map((owner) => ({
      owner,
      expectedAppliedVersion: appliedOf(snap, owner).appliedVersion
    }))
  })
}

// ---------------------------------------------------------------------------
// stage-configuration
// ---------------------------------------------------------------------------

describe('stage-configuration', () => {
  it('records a draft with applied and draft values, leaving applied untouched', async () => {
    const adapter = new MockScenarioAdapter()
    const result = await stage(adapter, projectOwner, 'general.name', '新名字')
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    const draft = draftOf(snap, projectOwner)
    expect(draft).toBeDefined()
    expect(draft!.appliedVersion).toBe(2)
    expect(draft!.changes).toEqual([
      { fieldPath: 'general.name', applied: '销售数据分析', draft: '新名字' }
    ])
    // Applied truth is untouched by staging (US-68).
    expect(appliedOf(snap, projectOwner).values['general.name']).toBe(
      '销售数据分析'
    )
    expect(appliedOf(snap, projectOwner).appliedVersion).toBe(2)
    expect(snap.projects[0].name).toBe('销售数据分析')
  })

  it('isolates the same field path per owner — two instances never cross', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccDataOwner, 'model.id', 'model-a')
    await stage(adapter, ccSqlOwner, 'model.id', 'model-b')

    const snap = await adapter.getSnapshot()
    expect(draftOf(snap, ccDataOwner)!.changes).toEqual([
      { fieldPath: 'model.id', applied: 'claude-sonnet-4', draft: 'model-a' }
    ])
    expect(draftOf(snap, ccSqlOwner)!.changes).toEqual([
      { fieldPath: 'model.id', applied: 'claude-sonnet-4', draft: 'model-b' }
    ])
  })

  it('validates on stage and records field-level errors without touching applied', async () => {
    const adapter = new MockScenarioAdapter()
    const result = await stage(adapter, ccSqlOwner, 'identity.name', '   ')
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    const draft = draftOf(snap, ccSqlOwner)
    expect(draft!.validationErrors).toEqual([
      { fieldPath: 'identity.name', message: 'Agent 名称不能为空' }
    ])
    expect(appliedOf(snap, ccSqlOwner).values['identity.name']).toBe('cc_sql')
  })

  it('rejects an unknown owner without side effects', async () => {
    const adapter = new MockScenarioAdapter()
    const result = await stage(
      adapter,
      { kind: 'agent', agentInstanceId: id('inst-nope', 'AgentInstanceId') },
      'model.id',
      'x'
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
    expect((await adapter.getSnapshot()).configurationDrafts).toHaveLength(0)
  })

  it('rejects a field path outside the owner catalogue', async () => {
    const adapter = new MockScenarioAdapter()
    const result = await stage(adapter, projectOwner, 'not.a.field', 'x')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
    // An agent field on the project owner is equally out of catalogue.
    const wrong = await stage(adapter, projectOwner, 'identity.name', 'x')
    expect(wrong.ok).toBe(false)
  })

  it('un-stages a change when the value returns to the applied one', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccDataOwner, 'model.id', 'model-a')
    let snap = await adapter.getSnapshot()
    expect(draftOf(snap, ccDataOwner)!.changes).toHaveLength(1)

    await stage(adapter, ccDataOwner, 'model.id', 'claude-sonnet-4')
    snap = await adapter.getSnapshot()
    expect(draftOf(snap, ccDataOwner)).toBeUndefined()
  })

  it('keeps drafts of other owners when one is staged', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccDataOwner, 'model.id', 'model-a')
    await stage(adapter, projectOwner, 'general.name', '另一个项目')
    const snap = await adapter.getSnapshot()
    expect(snap.configurationDrafts).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// discard-configuration
// ---------------------------------------------------------------------------

describe('discard-configuration', () => {
  it('drops the draft and its errors, restoring the applied view', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccSqlOwner, 'identity.name', '   ')
    await stage(adapter, ccSqlOwner, 'model.id', 'model-b')
    const result = await send(adapter, {
      kind: 'discard-configuration',
      owners: [ccSqlOwner]
    })
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    expect(draftOf(snap, ccSqlOwner)).toBeUndefined()
    expect(appliedOf(snap, ccSqlOwner).values['identity.name']).toBe('cc_sql')
  })

  it('only discards the listed owners', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccDataOwner, 'model.id', 'model-a')
    await stage(adapter, ccSqlOwner, 'model.id', 'model-b')
    await send(adapter, { kind: 'discard-configuration', owners: [ccDataOwner] })

    const snap = await adapter.getSnapshot()
    expect(draftOf(snap, ccDataOwner)).toBeUndefined()
    expect(draftOf(snap, ccSqlOwner)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// apply-configuration — atomic multi-owner commit
// ---------------------------------------------------------------------------

describe('apply-configuration', () => {
  it('atomically commits all listed owners and clears their drafts', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'general.name', '销售分析 v2')
    await stage(adapter, ccDataOwner, 'model.id', 'claude-opus-4')

    const events: WorkbenchEvent[] = []
    adapter.subscribe((e) => events.push(e))
    const result = await applyAll(adapter, [projectOwner, ccDataOwner])
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    expect(appliedOf(snap, projectOwner).appliedVersion).toBe(3)
    expect(appliedOf(snap, projectOwner).values['general.name']).toBe(
      '销售分析 v2'
    )
    expect(appliedOf(snap, ccDataOwner).appliedVersion).toBe(4)
    expect(appliedOf(snap, ccDataOwner).values['model.id']).toBe('claude-opus-4')
    expect(snap.configurationDrafts).toHaveLength(0)

    const applied = events.find((e) => e.kind === 'configuration-applied')
    expect(applied).toBeDefined()
    if (applied?.kind === 'configuration-applied') {
      expect(applied.owners).toHaveLength(2)
      expect(applied.owners).toContainEqual({
        owner: projectOwner,
        appliedVersion: 3
      })
      expect(applied.owners).toContainEqual({
        owner: ccDataOwner,
        appliedVersion: 4
      })
    }
  })

  it('rejects the whole apply when any owner version is stale', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'general.name', '销售分析 v2')
    await stage(adapter, ccDataOwner, 'model.id', 'claude-opus-4')

    const result = await send(adapter, {
      kind: 'apply-configuration',
      owners: [
        { owner: projectOwner, expectedAppliedVersion: 2 },
        // cc_data is actually at version 3.
        { owner: ccDataOwner, expectedAppliedVersion: 99 }
      ]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('stale-revision')

    // Nothing applied anywhere; both drafts survive.
    const snap = await adapter.getSnapshot()
    expect(appliedOf(snap, projectOwner).values['general.name']).toBe(
      '销售数据分析'
    )
    expect(appliedOf(snap, ccDataOwner).values['model.id']).toBe(
      'claude-sonnet-4'
    )
    expect(draftOf(snap, projectOwner)).toBeDefined()
    expect(draftOf(snap, ccDataOwner)).toBeDefined()
  })

  it('rejects the whole apply on any validation error, keeping every draft and error', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccSqlOwner, 'identity.name', '   ')
    await stage(adapter, ccDataOwner, 'model.id', 'claude-opus-4')

    const result = await applyAll(adapter, [ccSqlOwner, ccDataOwner])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invariant-violation')

    const snap = await adapter.getSnapshot()
    // No applied value moved — atomicity across owners (US-70).
    expect(appliedOf(snap, ccSqlOwner).appliedVersion).toBe(1)
    expect(appliedOf(snap, ccDataOwner).appliedVersion).toBe(3)
    expect(appliedOf(snap, ccDataOwner).values['model.id']).toBe(
      'claude-sonnet-4'
    )
    // All drafts and errors stay for the user to fix.
    expect(draftOf(snap, ccSqlOwner)!.validationErrors.length).toBeGreaterThan(0)
    expect(draftOf(snap, ccDataOwner)!.changes).toHaveLength(1)
  })

  it('rejects duplicate owners in one apply', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccDataOwner, 'model.id', 'model-a')
    const result = await send(adapter, {
      kind: 'apply-configuration',
      owners: [
        { owner: ccDataOwner, expectedAppliedVersion: 3 },
        { owner: ccDataOwner, expectedAppliedVersion: 3 }
      ]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })

  it('rejects applying an owner with no draft', async () => {
    const adapter = new MockScenarioAdapter()
    const result = await applyAll(adapter, [ccDataOwner])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })
})

// ---------------------------------------------------------------------------
// Effect timing — immediate identity vs next-Run configuration
// ---------------------------------------------------------------------------

describe('apply-configuration — effect timing', () => {
  it('applies Agent Name immediately while run configuration waits for the next Run', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccSqlOwner, 'identity.name', 'cc_sql_v2')
    await stage(adapter, ccDataOwner, 'model.id', 'claude-opus-4')
    const result = await applyAll(adapter, [ccSqlOwner, ccDataOwner])
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    // Identity + routing metadata take effect at once (US-91).
    const ccSql = snap.agents.find((a) => a.agentInstanceId === CC_SQL)!
    expect(ccSql.name).toBe('cc_sql_v2')
    // The active Run keeps its launch-time snapshot (US-71).
    const ccData = snap.agents.find((a) => a.agentInstanceId === CC_DATA)!
    expect(ccData.activeRunConfigVersion).toBe(3)
    expect(appliedOf(snap, ccDataOwner).appliedVersion).toBe(4)
  })

  it('rejects a rename that collides with another instance, case-insensitively', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccSqlOwner, 'identity.name', 'CC_DATA')
    const result = await applyAll(adapter, [ccSqlOwner])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invariant-violation')

    const snap = await adapter.getSnapshot()
    expect(snap.agents.find((a) => a.agentInstanceId === CC_SQL)!.name).toBe(
      'cc_sql'
    )
    expect(draftOf(snap, ccSqlOwner)).toBeDefined()
  })

  it('applies the project name immediately', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'general.name', '销售分析 v2')
    await applyAll(adapter, [projectOwner])
    const snap = await adapter.getSnapshot()
    expect(snap.projects[0].name).toBe('销售分析 v2')
  })
})

// ---------------------------------------------------------------------------
// Primary connection — optional 0..1 ConnectionId
// ---------------------------------------------------------------------------

describe('apply-configuration — primary connection', () => {
  it('supports clearing the primary connection (0 connections)', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'integrations.primaryConnectionId', null)
    const result = await applyAll(adapter, [projectOwner])
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    expect(snap.projects[0].primaryConnectionId).toBeUndefined()
    expect(
      appliedOf(snap, projectOwner).values['integrations.primaryConnectionId']
    ).toBeNull()
  })

  it('supports rebinding to exactly one other connection', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(
      adapter,
      projectOwner,
      'integrations.primaryConnectionId',
      CONN_PRODUCT
    )
    const result = await applyAll(adapter, [projectOwner])
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    expect(snap.projects[0].primaryConnectionId).toBe(CONN_PRODUCT)
  })

  it('flags an unknown connection as a validation error on stage', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(
      adapter,
      projectOwner,
      'integrations.primaryConnectionId',
      id('conn-nope', 'ConnectionId')
    )
    const snap = await adapter.getSnapshot()
    expect(
      draftOf(snap, projectOwner)!.validationErrors
    ).toHaveLength(1)
  })
})
