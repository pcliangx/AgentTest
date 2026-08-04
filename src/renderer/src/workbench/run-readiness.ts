/**
 * Derived workbench facts (#14): per-owner effective configuration and
 * per-Agent next-Run readiness.
 *
 * Pure functions over snapshot truth, recomputed on every emitted revision.
 * The renderer never derives these itself, and the adapter never stores
 * them as mutable truth — they are attached to outgoing snapshots only.
 */
import type {
  ConfigurationOwner,
  EffectiveConfigurationEntry,
  EffectiveConfigurationViewModel,
  RunReadinessBlocker,
  RunReadinessViewModel,
  WorkbenchViewModel
} from './contract'
import { fieldPathsFor } from './configuration'
import {
  getProjectDispatchBlockReason,
  type ProjectDispatchBlockReason
} from './dispatchability'
import { resolveProviderModelSelection } from './provider-capability'

/** Snapshot truth before the derived fields are attached. */
export type DerivedStateInput = Omit<
  WorkbenchViewModel,
  'effectiveConfigurations' | 'runReadiness'
>

/**
 * Phase 1 has no PermissionBroker: a permission policy is recorded intent
 * only and must never be reported as effective or enforced (#14).
 */
const PERMISSION_NOT_ENFORCEABLE_REASON =
  'PermissionBroker 尚未接入，策略仅记录为意图，无法强制执行'

/**
 * Readiness copy for project-level blockers — mirrors the adapter's
 * `projectExecutionUnavailableMessage` with the "启动新 Run" action. The
 * General section already shows root/Git status, so it is the link target.
 */
function projectBlockerMessage(reason: ProjectDispatchBlockReason): string {
  switch (reason) {
    case 'project-archived':
      return 'Project 已归档，不能启动新 Run'
    case 'project-root-unavailable':
      return 'Project Root 不可用，不能启动新 Run'
    case 'project-repository-not-ready':
      return 'Project 尚未初始化或绑定 Git 仓库，不能启动新 Run'
  }
}

export function computeEffectiveConfigurations(
  state: DerivedStateInput
): EffectiveConfigurationViewModel[] {
  return state.appliedConfigurations.map((applied) => ({
    owner: applied.owner,
    entries: fieldPathsFor(applied.owner).map((fieldPath) =>
      effectiveEntry(state, applied.owner, fieldPath, applied.values[fieldPath])
    )
  }))
}

function effectiveEntry(
  state: DerivedStateInput,
  owner: ConfigurationOwner,
  fieldPath: string,
  applied: unknown
): EffectiveConfigurationEntry {
  if (owner.kind === 'project') {
    if (fieldPath === 'permissions.defaultPolicy') {
      return {
        fieldPath,
        applied,
        status: 'blocked',
        blockedReason: PERMISSION_NOT_ENFORCEABLE_REASON
      }
    }
    if (fieldPath === 'defaults.providerId') {
      const provider = state.global.providers.find(
        (candidate) => candidate.providerId === applied
      )
      if (provider?.status === 'blocked') {
        return {
          fieldPath,
          applied,
          status: 'blocked',
          blockedReason: 'Provider Doctor 未通过，该默认值当前无法生效'
        }
      }
    }
    if (fieldPath === 'integrations.primaryConnectionId') {
      const connection = state.global.connections.find(
        (candidate) => candidate.connectionId === applied
      )
      if (connection?.status === 'offline' || connection?.status === 'error') {
        return {
          fieldPath,
          applied,
          status: 'blocked',
          blockedReason: '连接当前不可用'
        }
      }
    }
  } else if (fieldPath === 'model.id') {
    const agent = state.agents.find(
      (candidate) => candidate.agentInstanceId === owner.agentInstanceId
    )
    const provider = state.global.providers.find(
      (candidate) => candidate.providerId === agent?.providerId
    )
    if (provider?.status === 'blocked') {
      return {
        fieldPath,
        applied,
        status: 'blocked',
        blockedReason: 'Provider Doctor 未通过，该模型当前无法生效'
      }
    }
  }
  return { fieldPath, applied, status: 'effective' }
}

export function computeRunReadiness(
  state: DerivedStateInput
): RunReadinessViewModel[] {
  return state.agents.map((agent) => {
    const blockers: RunReadinessBlocker[] = []
    const provider = state.global.providers.find(
      (candidate) => candidate.providerId === agent.providerId
    )
    // Project lifecycle / root / repository facts degrade every Agent of
    // the project orthogonally (the shared dispatchability rule is the
    // single source for this judgment).
    const project = state.projects.find(
      (candidate) => candidate.projectId === agent.projectId
    )
    const projectBlock = project
      ? getProjectDispatchBlockReason(project)
      : undefined
    if (projectBlock) {
      blockers.push({
        code: projectBlock,
        message: projectBlockerMessage(projectBlock),
        target: { kind: 'settings-section', section: 'general' }
      })
    }
    // An archived Agent never starts a new Run; there is no edit location
    // that clears this, so the blocker carries no link target.
    if (agent.runtimeState === 'archived') {
      blockers.push({
        code: 'agent-archived',
        message: 'Agent 已归档，不能启动新 Run'
      })
    }
    // A failed Provider Doctor blocks the next Run of every instance of
    // that provider, and explains their degraded values on its own.
    if (provider?.status === 'blocked') {
      blockers.push({
        code: 'provider-blocked',
        message: 'Provider Doctor 未通过，不能启动新 Run',
        target: { kind: 'provider-health' }
      })
    }
    // Unavailable while the provider is ready is an honest per-Agent
    // blocker — recovery of the provider restores the Agent in place.
    if (agent.runtimeState === 'unavailable' && provider?.status === 'ready') {
      blockers.push({
        code: 'agent-unavailable',
        message: 'Agent 当前不可用，修复 Provider 后可恢复',
        target: { kind: 'provider-health' }
      })
    }
    // The applied model must still be offered by the provider. Skipped when
    // the provider itself is blocked — provider-blocked already explains
    // the degradation and must not double-report. The Instances section is
    // the single edit location for model.id.
    if (provider?.status !== 'blocked') {
      const applied = state.appliedConfigurations.find(
        (candidate) =>
          candidate.owner.kind === 'agent' &&
          candidate.owner.agentInstanceId === agent.agentInstanceId
      )
      const modelId = applied?.values['model.id']
      if (typeof modelId === 'string') {
        const selection = resolveProviderModelSelection(
          state.global.providers,
          agent.providerId,
          modelId
        )
        if (
          !selection.ok &&
          selection.code !== 'provider-missing' &&
          selection.code !== 'provider-unavailable'
        ) {
          blockers.push({
            code: 'model-unavailable',
            message: selection.message,
            target: {
              kind: 'settings-section',
              section: 'instances',
              agentInstanceId: agent.agentInstanceId
            }
          })
        }
      }
    }
    return {
      agentInstanceId: agent.agentInstanceId,
      projectId: agent.projectId,
      status: blockers.length > 0 ? 'blocked' : 'ready',
      blockers
    }
  })
}
