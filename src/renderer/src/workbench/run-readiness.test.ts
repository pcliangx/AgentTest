import { describe, it, expect } from 'vitest'
import { MockScenarioAdapter } from './mock-scenario-adapter'
import { id } from './contract'
import { createStandardScenario } from './standard-scenario'
import { fieldPathsFor } from './configuration'
import type {
  AgentInstanceId,
  CommandId,
  ConfigurationOwner,
  WorkbenchCommand,
  WorkbenchCommandBody,
  WorkbenchViewModel
} from './contract'

/**
 * Run readiness and effective-configuration domain tests (#14) — derived
 * facts exposed through the WorkbenchPort seam. The adapter recomputes them
 * on every emitted revision; the renderer only ever reads adapter-judged
 * facts and never derives business state itself.
 */

const PROJECT = id('proj-sales', 'ProjectId')
const RESEARCH = id('proj-research', 'ProjectId')
const CC_DATA = id('inst-cc-data', 'AgentInstanceId')
const KIMI_DOCS = id('inst-kimi-docs', 'AgentInstanceId')
const CX_REVIEW = id('inst-cx-review', 'AgentInstanceId')
const CLAUDE_CODE = id('claude-code', 'AgentProviderId')
const KIMI_CODE = id('kimi-code', 'AgentProviderId')
const CONN_PRIMARY = id('conn-feishu-primary', 'ConnectionId')

let commandCounter = 0
function cmd(): CommandId {
  return id(`cmd-rr-${++commandCounter}`, 'CommandId')
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

function ownerKey(owner: ConfigurationOwner): string {
  return owner.kind === 'project'
    ? `project:${owner.projectId}`
    : `agent:${owner.agentInstanceId}`
}

function effectiveOf(snap: WorkbenchViewModel, owner: ConfigurationOwner) {
  const key = ownerKey(owner)
  const entry = snap.effectiveConfigurations.find(
    (c) => ownerKey(c.owner) === key
  )
  if (!entry) throw new Error(`no effective configuration for ${key}`)
  return entry
}

function entryOf(
  snap: WorkbenchViewModel,
  owner: ConfigurationOwner,
  fieldPath: string
) {
  const entry = effectiveOf(snap, owner).entries.find(
    (e) => e.fieldPath === fieldPath
  )
  if (!entry) throw new Error(`no effective entry ${fieldPath} for ${ownerKey(owner)}`)
  return entry
}

function readinessOf(snap: WorkbenchViewModel, agentInstanceId: AgentInstanceId) {
  const entry = snap.runReadiness.find(
    (r) => r.agentInstanceId === agentInstanceId
  )
  if (!entry) throw new Error(`no run readiness for ${agentInstanceId}`)
  return entry
}

const projectOwner: ConfigurationOwner = { kind: 'project', projectId: PROJECT }
const researchOwner: ConfigurationOwner = {
  kind: 'project',
  projectId: RESEARCH
}

describe('derived snapshot facts (#14)', () => {
  it('exposes effectiveConfigurations per applied owner and runReadiness per agent', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()

    expect(
      snap.effectiveConfigurations.map((c) => ownerKey(c.owner)).sort()
    ).toEqual(
      snap.appliedConfigurations.map((c) => ownerKey(c.owner)).sort()
    )
    expect(snap.runReadiness.map((r) => r.agentInstanceId).sort()).toEqual(
      snap.agents.map((a) => a.agentInstanceId).sort()
    )

    // Entries cover exactly the catalogue field paths for each owner kind.
    for (const owner of [projectOwner, researchOwner]) {
      expect(effectiveOf(snap, owner).entries.map((e) => e.fieldPath)).toEqual(
        fieldPathsFor(owner)
      )
    }

    // Undegraded agents are ready for their next Run — busy/queued/running
    // states do not block queueing the next one.
    expect(readinessOf(snap, CC_DATA)).toMatchObject({
      projectId: PROJECT,
      status: 'ready',
      blockers: []
    })
    for (const agent of snap.agents) {
      if (agent.agentInstanceId === KIMI_DOCS) continue
      expect(readinessOf(snap, agent.agentInstanceId).status).toBe('ready')
    }

    // kimi_docs is unavailable while its provider is ready: an honest
    // per-agent blocker, never hidden by provider health.
    expect(readinessOf(snap, KIMI_DOCS)).toMatchObject({
      status: 'blocked',
      blockers: [
        {
          code: 'agent-unavailable',
          message: 'Agent 当前不可用，修复 Provider 后可恢复',
          target: { kind: 'provider-health' }
        }
      ]
    })

    // Phase 1 enforcement honesty: permission policy is only ever recorded
    // intent — it can never be reported effective without a PermissionBroker.
    for (const owner of [projectOwner, researchOwner]) {
      expect(entryOf(snap, owner, 'permissions.defaultPolicy')).toMatchObject({
        applied: 'ask-each-time',
        status: 'blocked',
        blockedReason:
          'PermissionBroker 尚未接入，策略仅记录为意图，无法强制执行'
      })
    }
  })
})

describe('provider degradation (#14)', () => {
  it('degrades a blocked provider’s agents in place and nothing else', async () => {
    const scenario = createStandardScenario()
    scenario.global.providers.find(
      (p) => p.providerId === CLAUDE_CODE
    )!.status = 'blocked'
    const pristine = createStandardScenario()
    const adapter = new MockScenarioAdapter(scenario)
    const snap = await adapter.getSnapshot()

    const claudeAgents = snap.agents.filter((a) => a.providerId === CLAUDE_CODE)
    expect(claudeAgents.length).toBeGreaterThan(0)
    for (const agent of claudeAgents) {
      // Existing instances display Unavailable with Doctor blocked (#14).
      expect(agent.runtimeState).toBe('unavailable')
      expect(agent.doctor).toBe('blocked')
      // Their next Run is blocked by provider health, nothing else.
      expect(readinessOf(snap, agent.agentInstanceId)).toMatchObject({
        status: 'blocked',
        blockers: [
          {
            code: 'provider-blocked',
            message: 'Provider Doctor 未通过，不能启动新 Run',
            target: { kind: 'provider-health' }
          }
        ]
      })
      // Their applied model cannot take effect while the provider is down.
      expect(
        entryOf(
          snap,
          { kind: 'agent', agentInstanceId: agent.agentInstanceId },
          'model.id'
        )
      ).toMatchObject({
        status: 'blocked',
        blockedReason: 'Provider Doctor 未通过，该模型当前无法生效'
      })
    }

    // Orthogonality: a single blocked provider only degrades that provider's
    // agents — every other instance keeps its exact scenario state.
    for (const agent of snap.agents.filter(
      (a) => a.providerId !== CLAUDE_CODE
    )) {
      const original = pristine.agents.find(
        (candidate) => candidate.agentInstanceId === agent.agentInstanceId
      )!
      expect(agent.runtimeState).toBe(original.runtimeState)
      expect(agent.doctor).toBe(original.doctor)
    }
    expect(readinessOf(snap, CX_REVIEW).status).toBe('ready')
    expect(readinessOf(snap, KIMI_DOCS).blockers).toEqual([
      {
        code: 'agent-unavailable',
        message: 'Agent 当前不可用，修复 Provider 后可恢复',
        target: { kind: 'provider-health' }
      }
    ])

    // Project defaults referencing the blocked provider cannot take effect.
    for (const owner of [projectOwner, researchOwner]) {
      expect(entryOf(snap, owner, 'defaults.providerId')).toMatchObject({
        applied: CLAUDE_CODE,
        status: 'blocked',
        blockedReason: 'Provider Doctor 未通过，该默认值当前无法生效'
      })
    }
  })

  it('restores degraded agents in place in the same revision as the provider flip', async () => {
    const scenario = createStandardScenario()
    scenario.global.providers.find(
      (p) => p.providerId === CLAUDE_CODE
    )!.status = 'blocked'
    const adapter = new MockScenarioAdapter(scenario)
    const before = await adapter.getSnapshot()
    const degradedIds = before.agents
      .filter((a) => a.providerId === CLAUDE_CODE)
      .map((a) => a.agentInstanceId)
    expect(degradedIds.length).toBeGreaterThan(0)

    const updates: Array<{ revision: number; snapshot: WorkbenchViewModel }> =
      []
    const unsubscribe = adapter.subscribe((event) => {
      if (event.kind === 'view-model-updated') {
        updates.push({ revision: event.revision, snapshot: event.snapshot })
      }
    })
    const result = await send(adapter, {
      kind: 'request-provider-recovery',
      providerId: CLAUDE_CODE
    })
    unsubscribe()

    expect(result.ok).toBe(true)
    // One atomic emission: provider flip and instance revival share a revision.
    expect(updates.length).toBe(1)
    if (result.ok) expect(updates[0].revision).toBe(result.acceptedRevision)

    const after = await adapter.getSnapshot()
    for (const snap of [updates[0].snapshot, after]) {
      expect(
        snap.global.providers.find((p) => p.providerId === CLAUDE_CODE)?.status
      ).toBe('ready')
      for (const agentId of degradedIds) {
        expect(snap.agents.find((a) => a.agentInstanceId === agentId)).toMatchObject({
          runtimeState: 'ready',
          doctor: 'ready'
        })
        expect(readinessOf(snap, agentId).status).toBe('ready')
        expect(
          entryOf(
            snap,
            { kind: 'agent', agentInstanceId: agentId },
            'model.id'
          ).status
        ).toBe('effective')
      }
      // kimi_docs sits on an already-ready provider and must not be revived.
      expect(snap.agents.find((a) => a.agentInstanceId === KIMI_DOCS)).toMatchObject({
        runtimeState: 'unavailable',
        doctor: 'ready'
      })
    }

    // Everything else about the revived agents is preserved: history, run
    // handles and identity survive the degrade/recover round trip. Compare
    // against the pre-recovery snapshot so only the recovery transition is
    // under test (construction may already have repaired stale projections).
    for (const agentId of degradedIds) {
      const prior = before.agents.find((a) => a.agentInstanceId === agentId)!
      const revived = after.agents.find((a) => a.agentInstanceId === agentId)!
      expect(revived.name).toBe(prior.name)
      expect(revived.lastActivityAt).toBe(prior.lastActivityAt)
      expect(revived.activeRunId).toEqual(prior.activeRunId)
      expect(revived.activeRunConfigVersion).toBe(prior.activeRunConfigVersion)
    }
    // Other providers' agents stay exactly as they were.
    for (const agent of after.agents.filter(
      (a) => a.providerId !== CLAUDE_CODE && a.agentInstanceId !== KIMI_DOCS
    )) {
      const original = scenario.agents.find(
        (candidate) => candidate.agentInstanceId === agent.agentInstanceId
      )!
      expect(agent.runtimeState).toBe(original.runtimeState)
      expect(agent.doctor).toBe(original.doctor)
    }
  })

  it('recovering an already-ready provider never revives an unavailable agent on it', async () => {
    const adapter = new MockScenarioAdapter()
    const before = await adapter.getSnapshot()
    expect(
      before.agents.find((a) => a.agentInstanceId === KIMI_DOCS)
    ).toMatchObject({ runtimeState: 'unavailable', doctor: 'ready' })

    // Today's contract is kept: recovering a ready provider is accepted as
    // a no-op, and it must not revive kimi_docs in passing.
    const result = await send(adapter, {
      kind: 'request-provider-recovery',
      providerId: KIMI_CODE
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    expect(
      after.agents.find((a) => a.agentInstanceId === KIMI_DOCS)
    ).toMatchObject({ runtimeState: 'unavailable', doctor: 'ready' })
    expect(readinessOf(after, KIMI_DOCS)).toMatchObject({
      status: 'blocked',
      blockers: [
        {
          code: 'agent-unavailable',
          message: 'Agent 当前不可用，修复 Provider 后可恢复',
          target: { kind: 'provider-health' }
        }
      ]
    })
  })
})

describe('connection degradation (#14)', () => {
  it('blocks the primary-connection value without blocking local runs', async () => {
    const scenario = createStandardScenario()
    scenario.global.connections.find(
      (c) => c.connectionId === CONN_PRIMARY
    )!.status = 'error'
    const adapter = new MockScenarioAdapter(scenario)
    const snap = await adapter.getSnapshot()

    expect(
      entryOf(snap, projectOwner, 'integrations.primaryConnectionId')
    ).toMatchObject({
      applied: CONN_PRIMARY,
      status: 'blocked',
      blockedReason: '连接当前不可用'
    })
    // Integration degradation never blocks local runs (#14 orthogonality).
    for (const agent of snap.agents.filter((a) => a.projectId === PROJECT)) {
      if (agent.agentInstanceId === KIMI_DOCS) continue
      expect(readinessOf(snap, agent.agentInstanceId).status).toBe('ready')
    }
    // The unbound research project stays effective (null passes through).
    expect(
      entryOf(snap, researchOwner, 'integrations.primaryConnectionId')
    ).toMatchObject({ applied: null, status: 'effective' })
  })
})

describe('model availability (#14)', () => {
  it('blocks the next Run when the applied model is not offered by the provider', async () => {
    const scenario = createStandardScenario()
    const applied = scenario.appliedConfigurations.find(
      (c) => c.owner.kind === 'agent' && c.owner.agentInstanceId === CX_REVIEW
    )!
    // Codex only offers gpt-5-codex in this scenario.
    applied.values['model.id'] = 'gpt-4o'
    const adapter = new MockScenarioAdapter(scenario)
    const snap = await adapter.getSnapshot()

    expect(readinessOf(snap, CX_REVIEW)).toMatchObject({
      status: 'blocked',
      blockers: [
        {
          code: 'model-unavailable',
          message: 'Codex 不支持模型 "gpt-4o"，请选择兼容模型',
          target: {
            kind: 'settings-section',
            section: 'instances',
            agentInstanceId: CX_REVIEW
          }
        }
      ]
    })
    // Other agents on the same provider keep their valid models.
    expect(
      readinessOf(snap, id('inst-cx-anti', 'AgentInstanceId')).status
    ).toBe('ready')
  })

  it('never double-reports model-unavailable when the provider is blocked', async () => {
    const scenario = createStandardScenario()
    scenario.global.providers.find(
      (p) => p.providerId === CLAUDE_CODE
    )!.status = 'blocked'
    const applied = scenario.appliedConfigurations.find(
      (c) => c.owner.kind === 'agent' && c.owner.agentInstanceId === CC_DATA
    )!
    applied.values['model.id'] = 'nonexistent-model'
    const adapter = new MockScenarioAdapter(scenario)
    const snap = await adapter.getSnapshot()

    // The provider failure already explains the degradation on its own.
    expect(readinessOf(snap, CC_DATA).blockers).toEqual([
      {
        code: 'provider-blocked',
        message: 'Provider Doctor 未通过，不能启动新 Run',
        target: { kind: 'provider-health' }
      }
    ])
  })
})

describe('agent lifecycle blockers (#14)', () => {
  it('an archived Agent cannot start a new Run and keeps no link target', async () => {
    const scenario = createStandardScenario()
    scenario.agents.find(
      (a) => a.agentInstanceId === CX_REVIEW
    )!.runtimeState = 'archived'
    const adapter = new MockScenarioAdapter(scenario)
    const snap = await adapter.getSnapshot()

    expect(readinessOf(snap, CX_REVIEW)).toMatchObject({
      status: 'blocked',
      blockers: [{ code: 'agent-archived', message: 'Agent 已归档，不能启动新 Run' }]
    })
    expect(
      readinessOf(snap, CX_REVIEW).blockers[0].target
    ).toBeUndefined()
    // Other agents are unaffected by one archived instance.
    expect(readinessOf(snap, CC_DATA).status).toBe('ready')
  })
})

describe('project degradation (#14)', () => {
  it.each([
    {
      condition: 'Project archived',
      configure: (snapshot: WorkbenchViewModel) => {
        snapshot.projects[0].lifecycle = 'archived'
      },
      code: 'project-archived',
      message: 'Project 已归档，不能启动新 Run'
    },
    {
      condition: 'Project Root unavailable',
      configure: (snapshot: WorkbenchViewModel) => {
        snapshot.projects[0].rootAvailability = 'unavailable'
      },
      code: 'project-root-unavailable',
      message: 'Project Root 不可用，不能启动新 Run'
    },
    {
      condition: 'repository not ready',
      configure: (snapshot: WorkbenchViewModel) => {
        snapshot.projects[0].repositoryReadiness = 'not-ready'
      },
      code: 'project-repository-not-ready',
      message: 'Project 尚未初始化或绑定 Git 仓库，不能启动新 Run'
    }
  ])(
    'blocks only that project’s agents when $condition',
    async ({ configure, code, message }) => {
      const scenario = createStandardScenario()
      configure(scenario)
      const adapter = new MockScenarioAdapter(scenario)
      const snap = await adapter.getSnapshot()

      const blocker = {
        code,
        message,
        target: { kind: 'settings-section', section: 'general' }
      }
      const degraded = snap.agents.filter((a) => a.projectId === PROJECT)
      expect(degraded.length).toBeGreaterThan(0)
      for (const agent of degraded) {
        const readiness = readinessOf(snap, agent.agentInstanceId)
        expect(readiness.status).toBe('blocked')
        if (agent.agentInstanceId === KIMI_DOCS) {
          // The project blocker comes first; the per-Agent blocker stays.
          expect(readiness.blockers).toEqual([
            blocker,
            {
              code: 'agent-unavailable',
              message: 'Agent 当前不可用，修复 Provider 后可恢复',
              target: { kind: 'provider-health' }
            }
          ])
        } else {
          expect(readiness.blockers).toEqual([blocker])
        }
      }

      // Orthogonality: the other project's agents stay ready, and project
      // facts are not rewritten into agent runtime state.
      for (const agent of snap.agents.filter(
        (a) => a.projectId === RESEARCH
      )) {
        expect(readinessOf(snap, agent.agentInstanceId).status).toBe('ready')
      }
      for (const agent of snap.agents) {
        const original = scenario.agents.find(
          (candidate) => candidate.agentInstanceId === agent.agentInstanceId
        )!
        expect(agent.runtimeState).toBe(original.runtimeState)
      }
    }
  )
})
