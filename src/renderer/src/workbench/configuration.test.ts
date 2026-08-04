import { describe, it, expect } from 'vitest'
import { MockScenarioAdapter } from './mock-scenario-adapter'
import { id } from './contract'
import { createStandardScenario } from './standard-scenario'
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
  it('creates a confirmation preview without changing the authoritative draft', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccSqlOwner, 'identity.name', 'cc_sql_v2')
    await stage(adapter, ccSqlOwner, 'model.id', 'model-b')
    const before = await adapter.getSnapshot()
    const result = await send(adapter, {
      kind: 'discard-configuration',
      owners: [ccSqlOwner]
    })
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    expect(draftOf(snap, ccSqlOwner)?.changes).toHaveLength(2)
    expect(appliedOf(snap, ccSqlOwner).values['identity.name']).toBe('cc_sql')
    expect(snap.pendingConfirmation).toMatchObject({
      action: '丢弃配置草稿',
      target: 'cc_sql'
    })
    expect(snap.pendingConfirmation!.impact).toContain('Agent 名称')
    expect(snap.pendingConfirmation!.impact).toContain('模型')
    expect(snap.pendingConfirmation!.impact).toContain('cc_sql_v2')
    expect(snap.pendingConfirmation!.impact).toContain('model-b')
    expect(snap.pendingConfirmation!.impact).toContain('不可恢复')
    expect(snap.pendingConfirmation!.nonBypassableReason).toContain('无法跳过')
    expect(snap.configurationDrafts).toEqual(before.configurationDrafts)
    expect(snap.appliedConfigurations).toEqual(before.appliedConfigurations)
    expect(snap.activity).toEqual(before.activity)
  })

  it('keeps every draft when the confirmation is dismissed', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccDataOwner, 'model.id', 'model-a')
    await stage(adapter, ccSqlOwner, 'model.id', 'model-b')
    const before = await adapter.getSnapshot()
    await send(adapter, { kind: 'discard-configuration', owners: [ccDataOwner] })
    const requested = await adapter.getSnapshot()

    await send(adapter, { kind: 'dismiss-confirmation' })

    const snap = await adapter.getSnapshot()
    expect(requested.pendingConfirmation).toBeDefined()
    expect(snap.pendingConfirmation).toBeUndefined()
    expect(snap.configurationDrafts).toEqual(before.configurationDrafts)
    expect(snap.appliedConfigurations).toEqual(before.appliedConfigurations)
    expect(snap.activity).toEqual(before.activity)
  })

  it('confirms only the previewed owner and records the result', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccDataOwner, 'model.id', 'model-a')
    await stage(adapter, ccSqlOwner, 'model.id', 'model-b')
    const appliedBefore = (await adapter.getSnapshot()).appliedConfigurations
    await send(adapter, { kind: 'discard-configuration', owners: [ccDataOwner] })
    const requested = await adapter.getSnapshot()

    const result = await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: requested.pendingConfirmation!.confirmationId
    })
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    expect(snap.pendingConfirmation).toBeUndefined()
    expect(draftOf(snap, ccDataOwner)).toBeUndefined()
    expect(draftOf(snap, ccSqlOwner)).toBeDefined()
    expect(snap.appliedConfigurations).toEqual(appliedBefore)
    expect(snap.activity[0]).toMatchObject({
      projectId: PROJECT,
      kind: 'dangerous-action-confirmed'
    })
    expect(snap.activity[0].summary).toContain('丢弃配置草稿')
    expect(snap.activity[0].summary).toContain('cc_data')
  })

  it('rejects an expired ConfirmationId without changing any draft', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccDataOwner, 'model.id', 'model-a')
    await stage(adapter, ccSqlOwner, 'model.id', 'model-b')
    await send(adapter, { kind: 'discard-configuration', owners: [ccDataOwner] })
    const first = await adapter.getSnapshot()
    const expiredId = first.pendingConfirmation!.confirmationId

    await send(adapter, { kind: 'dismiss-confirmation' })
    await send(adapter, { kind: 'discard-configuration', owners: [ccSqlOwner] })
    const latest = await adapter.getSnapshot()
    expect(latest.pendingConfirmation!.confirmationId).not.toBe(expiredId)

    const result = await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: expiredId
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')

    const snap = await adapter.getSnapshot()
    expect(snap.configurationDrafts).toEqual(latest.configurationDrafts)
    expect(snap.appliedConfigurations).toEqual(latest.appliedConfigurations)
    expect(snap.activity).toEqual(latest.activity)
    expect(snap.pendingConfirmation?.confirmationId).toBe(
      latest.pendingConfirmation!.confirmationId
    )
  })

  it('rejects confirmation when the previewed draft has changed', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccDataOwner, 'model.id', 'model-a')
    await send(adapter, { kind: 'discard-configuration', owners: [ccDataOwner] })
    const requested = await adapter.getSnapshot()

    await stage(adapter, ccDataOwner, 'env.custom', 'NEW_FLAG=1')
    const beforeConfirm = await adapter.getSnapshot()
    const result = await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: requested.pendingConfirmation!.confirmationId
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')

    const snap = await adapter.getSnapshot()
    expect(draftOf(snap, ccDataOwner)?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldPath: 'model.id', draft: 'model-a' }),
        expect.objectContaining({
          fieldPath: 'env.custom',
          draft: 'NEW_FLAG=1'
        })
      ])
    )
    expect(snap.pendingConfirmation?.confirmationId).toBe(
      requested.pendingConfirmation!.confirmationId
    )
    expect(snap.activity).toEqual(beforeConfirm.activity)
  })

  it('still confirms when only an unrelated owner changed after preview', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccDataOwner, 'model.id', 'model-a')
    await send(adapter, { kind: 'discard-configuration', owners: [ccDataOwner] })
    const requested = await adapter.getSnapshot()

    await stage(adapter, ccSqlOwner, 'env.custom', 'OTHER_FLAG=1')
    const result = await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: requested.pendingConfirmation!.confirmationId
    })
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    expect(draftOf(snap, ccDataOwner)).toBeUndefined()
    expect(draftOf(snap, ccSqlOwner)?.changes).toEqual([
      expect.objectContaining({
        fieldPath: 'env.custom',
        draft: 'OTHER_FLAG=1'
      })
    ])
  })

  it.each([{ FLAG: '1' }, ['FLAG=1']])(
    'confirms a cloneable invalid draft value %# when it has not changed',
    async (value) => {
      const adapter = new MockScenarioAdapter()
      await stage(adapter, ccDataOwner, 'env.custom', value)
      await send(adapter, {
        kind: 'discard-configuration',
        owners: [ccDataOwner]
      })
      const requested = await adapter.getSnapshot()

      const result = await send(adapter, {
        kind: 'confirm-dangerous-action',
        confirmationId: requested.pendingConfirmation!.confirmationId
      })
      expect(result.ok).toBe(true)
      expect(draftOf(await adapter.getSnapshot(), ccDataOwner)).toBeUndefined()
    }
  )

  it('confirms an explicit same-project multi-owner range without touching a third owner', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'general.name', '销售分析 v2')
    await stage(adapter, ccDataOwner, 'model.id', 'model-a')
    await stage(adapter, ccSqlOwner, 'env.custom', 'KEEP=1')
    const before = await adapter.getSnapshot()

    await send(adapter, {
      kind: 'discard-configuration',
      owners: [projectOwner, ccDataOwner]
    })
    const requested = await adapter.getSnapshot()
    expect(requested.pendingConfirmation?.target).toContain('销售数据分析')
    expect(requested.pendingConfirmation?.target).toContain('cc_data')

    const result = await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: requested.pendingConfirmation!.confirmationId
    })
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    expect(draftOf(snap, projectOwner)).toBeUndefined()
    expect(draftOf(snap, ccDataOwner)).toBeUndefined()
    expect(draftOf(snap, ccSqlOwner)).toEqual(draftOf(before, ccSqlOwner))
    expect(snap.appliedConfigurations).toEqual(before.appliedConfigurations)
    expect(snap.activity[0].projectId).toBe(PROJECT)
  })

  it('does not replace an existing confirmation with a second discard request', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccDataOwner, 'model.id', 'model-a')
    await stage(adapter, ccSqlOwner, 'model.id', 'model-b')
    await send(adapter, { kind: 'discard-configuration', owners: [ccDataOwner] })
    const first = await adapter.getSnapshot()

    const result = await send(adapter, {
      kind: 'discard-configuration',
      owners: [ccSqlOwner]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('busy')

    const snap = await adapter.getSnapshot()
    expect(snap.pendingConfirmation?.confirmationId).toBe(
      first.pendingConfirmation!.confirmationId
    )
    expect(draftOf(snap, ccDataOwner)).toBeDefined()
    expect(draftOf(snap, ccSqlOwner)).toBeDefined()
  })

  it('does not let another dangerous request replace the discard confirmation', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccDataOwner, 'model.id', 'model-a')
    await send(adapter, { kind: 'discard-configuration', owners: [ccDataOwner] })
    const first = await adapter.getSnapshot()

    const result = await send(adapter, {
      kind: 'request-connection-deletion',
      connectionId: first.global.connections[0].connectionId
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('busy')

    const snap = await adapter.getSnapshot()
    expect(snap.pendingConfirmation?.confirmationId).toBe(
      first.pendingConfirmation!.confirmationId
    )
    expect(draftOf(snap, ccDataOwner)).toEqual(draftOf(first, ccDataOwner))
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
    const staged = await adapter.getSnapshot()
    const result = await applyAll(adapter, [ccSqlOwner])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invariant-violation')

    const snap = await adapter.getSnapshot()
    expect(snap.agents.find((a) => a.agentInstanceId === CC_SQL)!.name).toBe(
      'cc_sql'
    )
    expect(appliedOf(snap, ccSqlOwner)).toEqual(appliedOf(staged, ccSqlOwner))
    expect(draftOf(snap, ccSqlOwner)).toEqual(draftOf(staged, ccSqlOwner))
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
  it('starts with applied resource scope projected from structured bindings', async () => {
    const snap = await new MockScenarioAdapter().getSnapshot()
    const labels = snap.projects[0].resourceBindings.map(
      (binding) => binding.label
    )
    expect(
      appliedOf(snap, projectOwner).values['integrations.resourceScope']
    ).toBe(labels.join('、'))
  })

  it('previews every binding invalidated by clearing the primary connection', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'integrations.primaryConnectionId', null)
    const result = await applyAll(adapter, [projectOwner])
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    expect(snap.pendingConfirmation).toBeDefined()
    expect(snap.pendingConfirmation!.action).toContain('集成')
    expect(snap.pendingConfirmation!.impact).toContain('销售团队任务清单')
    expect(snap.pendingConfirmation!.impact).toContain('销售知识库')
    expect(snap.pendingConfirmation!.impact).toContain('未同步 Knowledge 修改')
    expect(snap.pendingConfirmation!.impact).toContain(
      '销售知识库有未同步的修改'
    )
    // Requesting the transition is side-effect free until confirmation.
    expect(snap.projects[0].primaryConnectionId).toBe(CONN_PRIMARY)
    expect(snap.projects[0].resourceBindings).toHaveLength(2)
    expect(
      appliedOf(snap, projectOwner).values['integrations.primaryConnectionId']
    ).toBe(CONN_PRIMARY)
    expect(appliedOf(snap, projectOwner).appliedVersion).toBe(2)
    expect(draftOf(snap, projectOwner)).toBeDefined()
  })

  it('expires an integration preview when its Knowledge conflict changes', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'integrations.primaryConnectionId', null)
    await applyAll(adapter, [projectOwner])
    const preview = await adapter.getSnapshot()
    const conflict = preview.attentionItems.find(
      (item) =>
        item.state === 'open' &&
        item.kind === 'connection-conflict' &&
        item.target.kind === 'knowledge' &&
        item.target.projectId === PROJECT
    )!

    const resolved = await send(adapter, {
      kind: 'resolve-attention',
      attentionItemId: conflict.attentionItemId
    })
    expect(resolved.ok).toBe(true)
    const confirmed = await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: preview.pendingConfirmation!.confirmationId
    })

    expect(confirmed.ok).toBe(false)
    if (!confirmed.ok) expect(confirmed.reason).toBe('invalid-target')
    const after = await adapter.getSnapshot()
    expect(after.projects[0].primaryConnectionId).toBe(CONN_PRIMARY)
    expect(after.pendingConfirmation).toBeDefined()
  })

  it('requires connection-difference confirmation even with zero bindings', async () => {
    const scenario = createStandardScenario()
    scenario.projects[0].resourceBindings = []
    const applied = appliedOf(scenario, projectOwner)
    applied.values['integrations.resourceScope'] = ''
    const adapter = new MockScenarioAdapter(scenario)

    await stage(adapter, projectOwner, 'integrations.primaryConnectionId', null)
    const requested = await applyAll(adapter, [projectOwner])
    expect(requested.ok).toBe(true)

    const preview = await adapter.getSnapshot()
    expect(preview.pendingConfirmation).toBeDefined()
    expect(preview.pendingConfirmation!.target).toContain('无连接')
    expect(preview.pendingConfirmation!.impact).toContain('0 个')
    expect(preview.projects[0].primaryConnectionId).toBe(CONN_PRIMARY)
    expect(appliedOf(preview, projectOwner).appliedVersion).toBe(2)
    expect(draftOf(preview, projectOwner)).toBeDefined()
  })

  it('atomically switches connection, bindings and applied scope after confirmation', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(
      adapter,
      projectOwner,
      'integrations.primaryConnectionId',
      CONN_PRODUCT
    )
    const result = await applyAll(adapter, [projectOwner])
    expect(result.ok).toBe(true)

    const preview = await adapter.getSnapshot()
    expect(preview.pendingConfirmation).toBeDefined()
    expect(preview.pendingConfirmation!.target).toContain('飞书 · 产品团队')
    expect(preview.projects[0].primaryConnectionId).toBe(CONN_PRIMARY)

    const confirmed = await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: preview.pendingConfirmation!.confirmationId
    })
    expect(confirmed.ok).toBe(true)

    const after = await adapter.getSnapshot()
    expect(after.pendingConfirmation).toBeUndefined()
    expect(after.projects[0].primaryConnectionId).toBe(CONN_PRODUCT)
    expect(after.projects[0].resourceBindings).toEqual([])
    const knowledge = after.knowledge.find(
      (candidate) => candidate.projectId === projectOwner.projectId
    )!
    expect(knowledge.state).toBe('unavailable')
    expect(knowledge.connectionId).toBeUndefined()
    expect(knowledge.resourceBindingId).toBeUndefined()
    expect(knowledge.humanBrowserIdentity).toBeUndefined()
    expect(knowledge.connectorIdentity).toBeUndefined()
    expect(
      appliedOf(after, projectOwner).values['integrations.primaryConnectionId']
    ).toBe(CONN_PRODUCT)
    expect(
      appliedOf(after, projectOwner).values['integrations.resourceScope']
    ).toBe('')
    expect(appliedOf(after, projectOwner).appliedVersion).toBe(3)
    expect(draftOf(after, projectOwner)).toBeUndefined()
  })

  it('preserves a trusted target-connection binding during a switch', async () => {
    const scenario = createStandardScenario()
    const targetBinding = {
      bindingId: id('binding-product-plan', 'ResourceBindingId'),
      connectionId: CONN_PRODUCT,
      resourceType: 'document' as const,
      label: '产品规划文档',
      allowedOperations: ['read', 'update'] as const
    }
    scenario.projects[0].resourceBindings.push({
      ...targetBinding,
      allowedOperations: [...targetBinding.allowedOperations]
    })
    const adapter = new MockScenarioAdapter(scenario)
    await stage(
      adapter,
      projectOwner,
      'integrations.primaryConnectionId',
      CONN_PRODUCT
    )
    await stage(
      adapter,
      projectOwner,
      'integrations.resourceScope',
      targetBinding.label
    )
    const staged = await adapter.getSnapshot()
    expect(draftOf(staged, projectOwner)!.validationErrors).toEqual([])

    await applyAll(adapter, [projectOwner])
    const preview = await adapter.getSnapshot()
    expect(preview.pendingConfirmation!.impact).not.toContain(
      targetBinding.label
    )
    await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: preview.pendingConfirmation!.confirmationId
    })

    const after = await adapter.getSnapshot()
    expect(after.projects[0].primaryConnectionId).toBe(CONN_PRODUCT)
    expect(after.projects[0].resourceBindings).toEqual([
      {
        ...targetBinding,
        allowedOperations: [...targetBinding.allowedOperations]
      }
    ])
    expect(
      appliedOf(after, projectOwner).values['integrations.resourceScope']
    ).toBe(targetBinding.label)
  })

  it('freezes every owner in a destructive integration apply batch', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'integrations.primaryConnectionId', null)
    await stage(adapter, ccSqlOwner, 'model.id', 'model-after-confirmation')
    const before = await adapter.getSnapshot()

    await applyAll(adapter, [projectOwner, ccSqlOwner])
    const preview = await adapter.getSnapshot()
    expect(preview.pendingConfirmation).toBeDefined()
    expect(preview.projects).toEqual(before.projects)
    expect(preview.appliedConfigurations).toEqual(before.appliedConfigurations)
    expect(preview.configurationDrafts).toEqual(before.configurationDrafts)

    const events: WorkbenchEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const confirmationCommandId = cmd()
    const confirmationCommand: WorkbenchCommand = {
      kind: 'confirm-dangerous-action',
      commandId: confirmationCommandId,
      expectedRevision: preview.revision,
      confirmationId: preview.pendingConfirmation!.confirmationId
    }
    const confirmationResult = await adapter.dispatch(confirmationCommand)

    const after = await adapter.getSnapshot()
    expect(after.projects[0].primaryConnectionId).toBeUndefined()
    expect(appliedOf(after, projectOwner).appliedVersion).toBe(3)
    expect(appliedOf(after, ccSqlOwner).appliedVersion).toBe(
      appliedOf(before, ccSqlOwner).appliedVersion + 1
    )
    expect(appliedOf(after, ccSqlOwner).values['model.id']).toBe(
      'model-after-confirmation'
    )
    expect(draftOf(after, projectOwner)).toBeUndefined()
    expect(draftOf(after, ccSqlOwner)).toBeUndefined()
    const appliedEvents = events.filter(
      (event): event is Extract<WorkbenchEvent, { kind: 'configuration-applied' }> =>
        event.kind === 'configuration-applied'
    )
    expect(appliedEvents).toHaveLength(1)
    expect(appliedEvents[0].owners).toHaveLength(2)
    expect(appliedEvents[0].correlationId).toBe(confirmationCommandId)

    // CommandId replay returns the cached result without another commit,
    // event, version bump or audit record.
    expect(await adapter.dispatch(confirmationCommand)).toEqual(
      confirmationResult
    )
    expect(await adapter.getSnapshot()).toEqual(after)
    expect(
      events.filter((event) => event.kind === 'configuration-applied')
    ).toHaveLength(1)
  })

  it('blocks a frozen owner from being applied as a partial second batch', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'integrations.primaryConnectionId', null)
    await stage(adapter, ccSqlOwner, 'model.id', 'model-after-confirmation')
    await applyAll(adapter, [projectOwner, ccSqlOwner])
    const preview = await adapter.getSnapshot()

    const result = await applyAll(adapter, [ccSqlOwner])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('busy')

    const after = await adapter.getSnapshot()
    expect(after.pendingConfirmation).toEqual(preview.pendingConfirmation)
    expect(after.projects).toEqual(preview.projects)
    expect(after.appliedConfigurations).toEqual(preview.appliedConfigurations)
    expect(after.configurationDrafts).toEqual(preview.configurationDrafts)
  })

  it('keeps the complete transition draft and truth when confirmation is cancelled', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'integrations.primaryConnectionId', null)
    await applyAll(adapter, [projectOwner])

    const preview = await adapter.getSnapshot()
    const before = {
      project: structuredClone(preview.projects[0]),
      applied: structuredClone(appliedOf(preview, projectOwner)),
      draft: structuredClone(draftOf(preview, projectOwner))
    }
    const dismissed = await send(adapter, { kind: 'dismiss-confirmation' })
    expect(dismissed.ok).toBe(true)

    const after = await adapter.getSnapshot()
    expect(after.pendingConfirmation).toBeUndefined()
    expect(after.projects[0]).toEqual(before.project)
    expect(appliedOf(after, projectOwner)).toEqual(before.applied)
    expect(draftOf(after, projectOwner)).toEqual(before.draft)
  })

  it('rejects an expired confirmation without changing transition truth', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'integrations.primaryConnectionId', null)
    await applyAll(adapter, [projectOwner])
    const preview = await adapter.getSnapshot()

    const result = await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: id('expired-integration-confirmation', 'ConfirmationId')
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')

    const after = await adapter.getSnapshot()
    expect(after.projects).toEqual(preview.projects)
    expect(after.appliedConfigurations).toEqual(preview.appliedConfigurations)
    expect(after.configurationDrafts).toEqual(preview.configurationDrafts)
    expect(after.pendingConfirmation).toEqual(preview.pendingConfirmation)
  })

  it('fails closed when the frozen transition draft changes before confirmation', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(
      adapter,
      projectOwner,
      'integrations.primaryConnectionId',
      CONN_PRODUCT
    )
    await applyAll(adapter, [projectOwner])
    const preview = await adapter.getSnapshot()

    // Drift the same owner after the impact preview was frozen.
    await stage(
      adapter,
      projectOwner,
      'integrations.resourceScope',
      '销售团队任务清单'
    )
    const drifted = await adapter.getSnapshot()
    const failed = await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: preview.pendingConfirmation!.confirmationId
    })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.reason).toBe('invalid-target')

    const after = await adapter.getSnapshot()
    expect(after.projects).toEqual(drifted.projects)
    expect(after.appliedConfigurations).toEqual(drifted.appliedConfigurations)
    expect(after.configurationDrafts).toEqual(drifted.configurationDrafts)
    expect(after.pendingConfirmation).toEqual(drifted.pendingConfirmation)
  })

  it('does not let another dangerous request overwrite a frozen transition', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'integrations.primaryConnectionId', null)
    await applyAll(adapter, [projectOwner])
    const preview = await adapter.getSnapshot()

    const result = await applyAll(adapter, [projectOwner])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('busy')

    const after = await adapter.getSnapshot()
    expect(after.pendingConfirmation).toEqual(preview.pendingConfirmation)
    expect(after.projects).toEqual(preview.projects)
    expect(after.appliedConfigurations).toEqual(preview.appliedConfigurations)
    expect(after.configurationDrafts).toEqual(preview.configurationDrafts)
  })

  it('does not let discard remove drafts frozen by a pending transition', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'integrations.primaryConnectionId', null)
    await applyAll(adapter, [projectOwner])
    const preview = await adapter.getSnapshot()

    const result = await send(adapter, {
      kind: 'discard-configuration',
      owners: [projectOwner]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('busy')

    const after = await adapter.getSnapshot()
    expect(after.pendingConfirmation).toEqual(preview.pendingConfirmation)
    expect(after.configurationDrafts).toEqual(preview.configurationDrafts)
  })

  it('synchronises a narrowed resource scope with structured bindings', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    const trustedBinding = structuredClone(before.projects[0].resourceBindings[0])
    await stage(
      adapter,
      projectOwner,
      'integrations.resourceScope',
      '销售团队任务清单'
    )
    const requested = await applyAll(adapter, [projectOwner])
    expect(requested.ok).toBe(true)

    const preview = await adapter.getSnapshot()
    expect(preview.pendingConfirmation!.impact).toContain('销售知识库')
    await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: preview.pendingConfirmation!.confirmationId
    })

    const after = await adapter.getSnapshot()
    expect(after.projects[0].resourceBindings).toEqual([trustedBinding])
    const knowledge = after.knowledge.find(
      (candidate) => candidate.projectId === projectOwner.projectId
    )!
    expect(knowledge.state).toBe('unavailable')
    expect(knowledge.connectionId).toBe(CONN_PRIMARY)
    expect(knowledge.resourceBindingId).toBeUndefined()
    expect(
      appliedOf(after, projectOwner).values['integrations.resourceScope']
    ).toBe('销售团队任务清单')
  })

  it('rejects a resource scope that is not backed by a structured binding', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(
      adapter,
      projectOwner,
      'integrations.resourceScope',
      '不存在的资源'
    )
    const snap = await adapter.getSnapshot()
    expect(draftOf(snap, projectOwner)!.validationErrors[0].message).toContain(
      '未绑定'
    )

    const beforeApply = await adapter.getSnapshot()
    const result = await applyAll(adapter, [projectOwner])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invariant-violation')
    const afterApply = await adapter.getSnapshot()
    expect(afterApply).toEqual(beforeApply)
  })

  it('rejects duplicate resource labels instead of ambiguously collapsing them', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(
      adapter,
      projectOwner,
      'integrations.resourceScope',
      '销售知识库、销售知识库'
    )
    const snap = await adapter.getSnapshot()
    expect(draftOf(snap, projectOwner)!.validationErrors[0].message).toContain(
      '重复'
    )
  })

  it('rejects an ambiguous label shared by two structured bindings', async () => {
    const scenario = createStandardScenario()
    scenario.projects[0].resourceBindings.push({
      ...scenario.projects[0].resourceBindings[0],
      bindingId: id('binding-sales-tasks-duplicate', 'ResourceBindingId')
    })
    const adapter = new MockScenarioAdapter(scenario)
    await stage(
      adapter,
      projectOwner,
      'integrations.resourceScope',
      '销售团队任务清单'
    )
    const snap = await adapter.getSnapshot()
    expect(draftOf(snap, projectOwner)!.validationErrors[0].message).toContain(
      '不唯一'
    )
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
  it('accepts a two-agent name swap based on the final Project name set', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccSqlOwner, 'identity.name', 'cc_etl')
    await stage(adapter, ccEtlOwner, 'identity.name', 'cc_sql')
    const staged = await adapter.getSnapshot()
    expect(draftOf(staged, ccSqlOwner)!.validationErrors).toHaveLength(1)
    expect(draftOf(staged, ccEtlOwner)!.validationErrors).toHaveLength(1)

    const result = await applyAll(adapter, [ccSqlOwner, ccEtlOwner])
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    expect(
      snap.agents.find((agent) => agent.agentInstanceId === CC_SQL)!.name
    ).toBe('cc_etl')
    expect(
      snap.agents.find((agent) => agent.agentInstanceId === CC_ETL)!.name
    ).toBe('cc_sql')
    expect(appliedOf(snap, ccSqlOwner).values['identity.name']).toBe('cc_etl')
    expect(appliedOf(snap, ccEtlOwner).values['identity.name']).toBe('cc_sql')
    expect(draftOf(snap, ccSqlOwner)).toBeUndefined()
    expect(draftOf(snap, ccEtlOwner)).toBeUndefined()
  })

  it('accepts a three-agent name cycle based on the final Project name set', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccDataOwner, 'identity.name', 'cc_sql')
    await stage(adapter, ccSqlOwner, 'identity.name', 'cc_etl')
    await stage(adapter, ccEtlOwner, 'identity.name', 'cc_data')
    const staged = await adapter.getSnapshot()

    const result = await applyAll(adapter, [
      ccDataOwner,
      ccSqlOwner,
      ccEtlOwner
    ])
    expect(result.ok).toBe(true)

    const snap = await adapter.getSnapshot()
    expect(
      snap.agents.find((agent) => agent.agentInstanceId === CC_DATA)!.name
    ).toBe('cc_sql')
    expect(
      snap.agents.find((agent) => agent.agentInstanceId === CC_SQL)!.name
    ).toBe('cc_etl')
    expect(
      snap.agents.find((agent) => agent.agentInstanceId === CC_ETL)!.name
    ).toBe('cc_data')
    expect(appliedOf(snap, ccDataOwner).values['identity.name']).toBe('cc_sql')
    expect(appliedOf(snap, ccSqlOwner).values['identity.name']).toBe('cc_etl')
    expect(appliedOf(snap, ccEtlOwner).values['identity.name']).toBe('cc_data')
    for (const owner of [ccDataOwner, ccSqlOwner, ccEtlOwner]) {
      expect(appliedOf(snap, owner).appliedVersion).toBe(
        appliedOf(staged, owner).appliedVersion + 1
      )
      expect(draftOf(snap, owner)).toBeUndefined()
    }
  })

  it('rejects the batch when final names are exactly equal', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccSqlOwner, 'identity.name', 'duplicate')
    await stage(adapter, ccEtlOwner, 'identity.name', 'duplicate')
    const staged = await adapter.getSnapshot()

    const result = await applyAll(adapter, [ccSqlOwner, ccEtlOwner])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invariant-violation')

    const snap = await adapter.getSnapshot()
    expect(appliedOf(snap, ccSqlOwner)).toEqual(appliedOf(staged, ccSqlOwner))
    expect(appliedOf(snap, ccEtlOwner)).toEqual(appliedOf(staged, ccEtlOwner))
    expect(draftOf(snap, ccSqlOwner)).toEqual(draftOf(staged, ccSqlOwner))
    expect(draftOf(snap, ccEtlOwner)).toEqual(draftOf(staged, ccEtlOwner))
  })

  it('rejects the batch when pending renames collide case-insensitively', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, ccSqlOwner, 'identity.name', 'duplicate')
    await stage(adapter, ccEtlOwner, 'identity.name', 'DUPLICATE')
    const staged = await adapter.getSnapshot()

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
    expect(appliedOf(snap, ccSqlOwner)).toEqual(appliedOf(staged, ccSqlOwner))
    expect(appliedOf(snap, ccEtlOwner)).toEqual(appliedOf(staged, ccEtlOwner))
    expect(draftOf(snap, ccSqlOwner)).toEqual(draftOf(staged, ccSqlOwner))
    expect(draftOf(snap, ccEtlOwner)).toEqual(draftOf(staged, ccEtlOwner))
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
    expect(
      appliedOf(after, projectOwner).values['integrations.resourceScope']
    ).toBe('')
  })

  it('does not canonicalise an unrelated project during connection deletion', async () => {
    const scenario = createStandardScenario()
    const unrelated = appliedOf(scenario, researchOwner)
    unrelated.values['integrations.resourceScope'] = '独立离线范围'
    const before = structuredClone(unrelated)
    const adapter = new MockScenarioAdapter(scenario)

    const snap = await adapter.getSnapshot()
    await send(adapter, {
      kind: 'request-connection-deletion',
      connectionId: CONN_PRIMARY
    })
    const preview = await adapter.getSnapshot()
    await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: preview.pendingConfirmation!.confirmationId
    })

    const after = await adapter.getSnapshot()
    expect(appliedOf(after, researchOwner)).toEqual(before)
    expect(after.projects.find((project) => project.projectId === RESEARCH)).toEqual(
      snap.projects.find((project) => project.projectId === RESEARCH)
    )
  })

  it('previews a legacy binding reference even when it is not the primary connection', async () => {
    const scenario = createStandardScenario()
    const research = scenario.projects.find(
      (project) => project.projectId === RESEARCH
    )!
    research.resourceBindings.push({
      bindingId: id('binding-research-legacy', 'ResourceBindingId'),
      connectionId: CONN_PRIMARY,
      resourceType: 'document',
      label: '遗留研究文档',
      allowedOperations: ['read']
    })
    const adapter = new MockScenarioAdapter(scenario)

    await send(adapter, {
      kind: 'request-connection-deletion',
      connectionId: CONN_PRIMARY
    })
    const preview = await adapter.getSnapshot()
    expect(preview.pendingConfirmation!.impact).toContain(research.name)
    expect(preview.pendingConfirmation!.impact).toContain('遗留研究文档')
  })

  it('fails closed when an affected project changes after deletion preview', async () => {
    const adapter = new MockScenarioAdapter()
    await send(adapter, {
      kind: 'request-connection-deletion',
      connectionId: CONN_PRIMARY
    })
    const preview = await adapter.getSnapshot()
    await stage(adapter, projectOwner, 'general.name', '删除预览后的草稿')
    const drifted = await adapter.getSnapshot()

    const result = await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: preview.pendingConfirmation!.confirmationId
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')

    const after = await adapter.getSnapshot()
    expect(after.global.connections).toEqual(drifted.global.connections)
    expect(after.projects).toEqual(drifted.projects)
    expect(after.appliedConfigurations).toEqual(drifted.appliedConfigurations)
    expect(after.configurationDrafts).toEqual(drifted.configurationDrafts)
    expect(after.pendingConfirmation).toEqual(drifted.pendingConfirmation)
    expect(after.activity).toEqual(drifted.activity)
  })

  it('applying a primary-connection change invalidates the old bindings', async () => {
    const adapter = new MockScenarioAdapter()
    await stage(adapter, projectOwner, 'integrations.primaryConnectionId', null)
    const result = await applyAll(adapter, [projectOwner])
    expect(result.ok).toBe(true)

    const preview = await adapter.getSnapshot()
    await send(adapter, {
      kind: 'confirm-dangerous-action',
      confirmationId: preview.pendingConfirmation!.confirmationId
    })
    const after = await adapter.getSnapshot()
    expect(after.projects[0].primaryConnectionId).toBeUndefined()
    expect(after.projects[0].resourceBindings).toEqual([])
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
