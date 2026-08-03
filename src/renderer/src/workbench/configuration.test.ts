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
const RESEARCH = id('proj-research', 'ProjectId')
const CC_DATA = id('inst-cc-data', 'AgentInstanceId')
const CC_SQL = id('inst-cc-sql', 'AgentInstanceId')
const CC_ETL = id('inst-cc-etl', 'AgentInstanceId')
const CONN_PRIMARY = id('conn-feishu-primary', 'ConnectionId')
const CONN_PRODUCT = id('conn-feishu-product', 'ConnectionId')

const projectOwner: ConfigurationOwner = { kind: 'project', projectId: PROJECT }
const researchOwner: ConfigurationOwner = {
  kind: 'project',
  projectId: RESEARCH
}
const ccDataOwner: ConfigurationOwner = {
  kind: 'agent',
  agentInstanceId: CC_DATA
}
const ccSqlOwner: ConfigurationOwner = { kind: 'agent', agentInstanceId: CC_SQL }
const ccEtlOwner: ConfigurationOwner = { kind: 'agent', agentInstanceId: CC_ETL }

const STATIC_SELECT_CASES: ReadonlyArray<{
  owner: ConfigurationOwner
  fieldPath: string
  values: readonly string[]
}> = [
  {
    owner: projectOwner,
    fieldPath: 'general.landingSurface',
    values: ['agents', 'overview']
  },
  {
    owner: projectOwner,
    fieldPath: 'defaults.openMode',
    values: ['new-panel', 'background', 'current-panel']
  },
  {
    owner: projectOwner,
    fieldPath: 'defaults.worktreeMode',
    values: ['read-only-shared', 'isolated']
  },
  {
    owner: projectOwner,
    fieldPath: 'permissions.defaultPolicy',
    values: ['deny-by-default', 'ask-each-time']
  },
  {
    owner: ccDataOwner,
    fieldPath: 'concurrency.priority',
    values: ['high', 'low', 'normal']
  }
]

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
    await stage(adapter, projectOwner, 'general.name', '保留中的草稿')
    const before = await adapter.getSnapshot()
    const result = await stage(adapter, projectOwner, 'not.a.field', 'x')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
    // An agent field on the project owner is equally out of catalogue.
    const wrong = await stage(adapter, projectOwner, 'identity.name', 'x')
    expect(wrong.ok).toBe(false)
    expect((await adapter.getSnapshot()).configurationDrafts).toEqual(
      before.configurationDrafts
    )
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
  it('applies every declared value for all five static select fields', async () => {
    for (const { owner, fieldPath, values } of STATIC_SELECT_CASES) {
      for (const value of values) {
        const adapter = new MockScenarioAdapter()
        const initial = appliedOf(await adapter.getSnapshot(), owner).values[
          fieldPath
        ]

        // A value equal to the initial truth intentionally un-stages. Move
        // away first so every declared value is exercised as a real Apply.
        if (Object.is(initial, value)) {
          const alternate = values.find((candidate) => candidate !== value)!
          await stage(adapter, owner, fieldPath, alternate)
          const baselineResult = await applyAll(adapter, [owner])
          if (!baselineResult.ok) throw new Error(baselineResult.message)
        }

        expect(await stage(adapter, owner, fieldPath, value)).toMatchObject({
          ok: true
        })
        const result = await applyAll(adapter, [owner])
        if (!result.ok) throw new Error(result.message)
        expect(
          appliedOf(await adapter.getSnapshot(), owner).values[fieldPath]
        ).toBe(value)
      }
    }
  })

  it('atomically applies static select fields across project and agent owners', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'defaults.openMode', 'new-panel')
    await stage(adapter, ccDataOwner, 'concurrency.priority', 'high')

    const result = await applyAll(adapter, [projectOwner, ccDataOwner])
    expect(result.ok).toBe(true)

    const snapshot = await adapter.getSnapshot()
    expect(appliedOf(snapshot, projectOwner).values['defaults.openMode']).toBe(
      'new-panel'
    )
    expect(
      appliedOf(snapshot, ccDataOwner).values['concurrency.priority']
    ).toBe('high')
    expect(snapshot.configurationDrafts).toHaveLength(0)
  })

  it('rejects undeclared values for every static select without changing applied truth or drafts', async () => {
    for (const { owner, fieldPath } of STATIC_SELECT_CASES) {
      const adapter = new MockScenarioAdapter()
      const before = await adapter.getSnapshot()
      const staged = await stage(adapter, owner, fieldPath, 'not-declared')
      expect(staged.ok).toBe(true)

      const withDraft = await adapter.getSnapshot()
      expect(draftOf(withDraft, owner)?.validationErrors).toEqual([
        expect.objectContaining({ fieldPath })
      ])

      const result = await applyAll(adapter, [owner])
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('invariant-violation')

      const after = await adapter.getSnapshot()
      expect(appliedOf(after, owner)).toEqual(appliedOf(before, owner))
      expect(draftOf(after, owner)).toEqual(draftOf(withDraft, owner))
    }
  })

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

// ---------------------------------------------------------------------------
// PR #27 review fixes
// ---------------------------------------------------------------------------

describe('apply/discard — single-project batches only', () => {
  it('rejects an apply batch spanning multiple projects without side effects', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'general.name', '销售分析 v2')
    await stage(adapter, researchOwner, 'general.name', '用户研究 v2')

    const result = await applyAll(adapter, [projectOwner, researchOwner])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')

    // Nothing applied anywhere; both drafts survive untouched.
    const snap = await adapter.getSnapshot()
    expect(snap.projects[0].name).toBe('销售数据分析')
    expect(snap.projects[1].name).toBe('用户研究')
    expect(draftOf(snap, projectOwner)).toBeDefined()
    expect(draftOf(snap, researchOwner)).toBeDefined()
  })

  it('rejects a discard batch spanning multiple projects', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'general.name', '销售分析 v2')
    await stage(adapter, researchOwner, 'general.name', '用户研究 v2')

    const result = await send(adapter, {
      kind: 'discard-configuration',
      owners: [projectOwner, researchOwner]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')

    const snap = await adapter.getSnapshot()
    expect(draftOf(snap, projectOwner)).toBeDefined()
    expect(draftOf(snap, researchOwner)).toBeDefined()
  })

  it('accepts a batch of one project plus its own instances', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'general.name', '销售分析 v2')
    await stage(adapter, ccDataOwner, 'model.id', 'claude-opus-4')
    const result = await applyAll(adapter, [projectOwner, ccDataOwner])
    expect(result.ok).toBe(true)
  })
})

describe('apply-configuration — batch rename uniqueness', () => {
  it('rejects the batch when pending renames collide case-insensitively', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccSqlOwner, 'identity.name', 'duplicate')
    await stage(adapter, ccEtlOwner, 'identity.name', 'DUPLICATE')

    const result = await applyAll(adapter, [ccSqlOwner, ccEtlOwner])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invariant-violation')

    // No rename happened; the project name set stays valid.
    const snap = await adapter.getSnapshot()
    expect(snap.agents.find((a) => a.agentInstanceId === CC_SQL)!.name).toBe(
      'cc_sql'
    )
    expect(snap.agents.find((a) => a.agentInstanceId === CC_ETL)!.name).toBe(
      'cc_etl'
    )
  })

  it('accepts renames whose final set is unique', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccSqlOwner, 'identity.name', 'cc_sql_v2')
    await stage(adapter, ccEtlOwner, 'identity.name', 'cc_etl_v2')
    const result = await applyAll(adapter, [ccSqlOwner, ccEtlOwner])
    expect(result.ok).toBe(true)
  })
})

describe('create-agent — configuration initialisation', () => {
  it('stores the selected Provider-compatible model and worktree mode', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const created = await adapter.dispatch({
      kind: 'create-agent',
      commandId: cmd(),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      name: 'cx_new',
      providerId: id('codex', 'AgentProviderId'),
      modelId: 'gpt-5-codex',
      open: 'background',
      worktreeMode: 'read-only-shared'
    })
    expect(created.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const instance = after.agents.find((agent) => agent.name === 'cx_new')!
    const config = appliedOf(after, {
      kind: 'agent',
      agentInstanceId: instance.agentInstanceId
    })
    expect(instance.providerId).toBe(id('codex', 'AgentProviderId'))
    expect(config.values['model.id']).toBe('gpt-5-codex')
    expect(instance.worktreeMode).toBe('read-only-shared')
  })

  it('creates an applied configuration from confirmed creation values, editable at once', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const created = await adapter.dispatch({
      kind: 'create-agent',
      commandId: cmd(),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      name: 'cc_new',
      providerId: id('claude-code', 'AgentProviderId'),
      modelId: 'claude-sonnet-4',
      open: 'background',
      worktreeMode: 'isolated'
    })
    expect(created.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const instance = after.agents.find((a) => a.name === 'cc_new')!
    const config = after.appliedConfigurations.find(
      (c) =>
        c.owner.kind === 'agent' &&
        c.owner.agentInstanceId === instance.agentInstanceId
    )
    // Full agent field set at version 1, including the confirmed model.
    expect(config).toBeDefined()
    expect(config!.appliedVersion).toBe(1)
    expect(config!.values['identity.name']).toBe('cc_new')
    expect(config!.values['model.id']).toBe('claude-sonnet-4')

    // The new instance is immediately editable through Settings commands.
    const staged = await stage(
      adapter,
      { kind: 'agent', agentInstanceId: instance.agentInstanceId },
      'model.id',
      'claude-opus-4'
    )
    expect(staged.ok).toBe(true)
  })
})

describe('primary connection — atomic truth across transitions', () => {
  it('connection deletion synchronises applied truth and drops its bindings', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'request-connection-deletion',
      commandId: cmd(),
      expectedRevision: snap.revision,
      connectionId: CONN_PRIMARY
    })
    const snap2 = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmd(),
      expectedRevision: snap2.revision,
      confirmationId: snap2.pendingConfirmation!.confirmationId
    })

    const after = await adapter.getSnapshot()
    // Applied truth follows the deletion: no stale connection id can be
    // resurrected by a later configuration apply.
    expect(
      appliedOf(after, projectOwner).values['integrations.primaryConnectionId']
    ).toBeNull()
    expect(appliedOf(after, projectOwner).appliedVersion).toBe(3)
    expect(after.projects[0].primaryConnectionId).toBeUndefined()
    // Bindings of the deleted connection are invalid — they go with it.
    expect(after.projects[0].resourceBindings).toEqual([])
  })

  it('applying a primary-connection change invalidates the old bindings', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'integrations.primaryConnectionId', null)
    const result = await applyAll(adapter, [projectOwner])
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    expect(snap.projects[0].primaryConnectionId).toBeUndefined()
    expect(snap.projects[0].resourceBindings).toEqual([])
  })

  it('stale-rejects a draft whose base version the deletion advanced', async () => {
    const adapter = new MockScenarioAdapter()
    // Draft based on applied v2…
    await stage(
      adapter,
      projectOwner,
      'integrations.primaryConnectionId',
      CONN_PRODUCT
    )
    // …then the global deletion advances the applied truth to v3.
    const snap = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'request-connection-deletion',
      commandId: cmd(),
      expectedRevision: snap.revision,
      connectionId: CONN_PRIMARY
    })
    const snap2 = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmd(),
      expectedRevision: snap2.revision,
      confirmationId: snap2.pendingConfirmation!.confirmationId
    })

    // Even sending the draft's captured base, the apply must stale-reject —
    // the v2 draft must never silently overwrite v3.
    const result = await send(adapter, {
      kind: 'apply-configuration',
      owners: [{ owner: projectOwner, expectedAppliedVersion: 2 }]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('stale-revision')

    const after = await adapter.getSnapshot()
    expect(
      appliedOf(after, projectOwner).values['integrations.primaryConnectionId']
    ).toBeNull()
    expect(draftOf(after, projectOwner)).toBeDefined()
  })
})

describe('apply-configuration — rejection purity', () => {
  it('publishes validation failure via the rejection, never by mutating the snapshot', async () => {
    const adapter = new MockScenarioAdapter()
    // Stage a valid rebind…
    await stage(
      adapter,
      projectOwner,
      'integrations.primaryConnectionId',
      CONN_PRODUCT
    )
    // …then delete the target connection: the staged value turns invalid
    // AFTER it was recorded.
    const snap = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'request-connection-deletion',
      commandId: cmd(),
      expectedRevision: snap.revision,
      connectionId: CONN_PRODUCT
    })
    const snap2 = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmd(),
      expectedRevision: snap2.revision,
      confirmationId: snap2.pendingConfirmation!.confirmationId
    })

    const before = await adapter.getSnapshot()
    const events: WorkbenchEvent[] = []
    adapter.subscribe((e) => events.push(e))
    const result = await applyAll(adapter, [projectOwner])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invariant-violation')
      // The rejection itself carries the discovered error.
      expect(result.message).toContain('连接不存在')
    }

    const after = await adapter.getSnapshot()
    // Rejection purity: no revision bump, no silent draft mutation, no
    // view-model update at a stale revision.
    expect(after.revision).toBe(before.revision)
    expect(draftOf(after, projectOwner)!.validationErrors).toEqual([])
    expect(
      events.every((e) => e.kind !== 'view-model-updated')
    ).toBe(true)
    // The draft itself survives for the user to fix.
    expect(draftOf(after, projectOwner)!.changes).toHaveLength(1)
  })
})

describe('apply-configuration — audit attribution', () => {
  it('records the activity entry with its project attribution', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccSqlOwner, 'model.id', 'model-b')
    await applyAll(adapter, [ccSqlOwner])

    const snap = await adapter.getSnapshot()
    const entry = snap.activity[0]
    expect(entry.kind).toBe('configuration-applied')
    expect(entry.projectId).toBe(PROJECT)
  })
})
