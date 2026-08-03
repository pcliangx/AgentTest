import type {
  DispatchPlanRequest,
  DispatchPlanResult,
  WorkbenchViewModel
} from './contract'
import {
  getDispatchBlockReason,
  getProjectDispatchBlockReason,
  isActiveStructuredRunState,
  isAgentBusy
} from './dispatchability'

function reject(
  snapshot: WorkbenchViewModel,
  reason: Extract<DispatchPlanResult, { ok: false }>['reason'],
  message: string
): DispatchPlanResult {
  return {
    ok: false,
    reason,
    latestRevision: snapshot.revision,
    message
  }
}

/**
 * Builds the authoritative, deterministic start/queue projection for one
 * ordered dispatch request. The calculation is side-effect free; capacity is
 * reserved virtually within the batch and queue positions remain
 * Project-scoped.
 */
export function buildDispatchPlan(
  snapshot: WorkbenchViewModel,
  request: DispatchPlanRequest
): DispatchPlanResult {
  if (request.expectedRevision !== snapshot.revision) {
    return reject(snapshot, 'stale-revision', 'revision 已过期')
  }

  const project = snapshot.projects.find(
    (candidate) => candidate.projectId === request.projectId
  )
  if (!project) return reject(snapshot, 'invalid-target', 'Project 不存在')
  if (getProjectDispatchBlockReason(project)) {
    return reject(snapshot, 'unavailable', 'Project 当前不可派发')
  }
  if (request.targets.length === 0) {
    return reject(snapshot, 'invalid-target', '目标不能为空')
  }
  if (
    new Set(request.targets as readonly string[]).size !==
    request.targets.length
  ) {
    return reject(snapshot, 'invalid-target', '目标不能包含重复 Agent')
  }

  const projectAgents = snapshot.agents.filter(
    (agent) => agent.projectId === project.projectId
  )
  const agentsById = new Map(
    projectAgents.map((agent) => [agent.agentInstanceId, agent] as const)
  )
  const targets = request.targets.map((target) => agentsById.get(target))
  if (targets.some((target) => target === undefined)) {
    return reject(
      snapshot,
      'invalid-target',
      '部分目标 Agent 不存在，已拒绝整单派发'
    )
  }
  if (targets.some((target) => getDispatchBlockReason(target!))) {
    return reject(
      snapshot,
      'unavailable',
      '部分目标 Agent 不可派发，已拒绝整单派发'
    )
  }

  let projectActive = projectAgents.filter((agent) =>
    isActiveStructuredRunState(agent.runtimeState)
  ).length
  let globalActive = snapshot.agents.filter((agent) =>
    isActiveStructuredRunState(agent.runtimeState)
  ).length
  let queuePosition = snapshot.queue.filter(
    (item) => item.projectId === project.projectId
  ).length

  const entries = targets.map((agent) => {
    const shouldQueue =
      isAgentBusy(agent!) ||
      projectActive >= snapshot.global.concurrency.projectLimit ||
      globalActive >= snapshot.global.concurrency.globalLimit
    if (shouldQueue) {
      queuePosition += 1
      return {
        agentInstanceId: agent!.agentInstanceId,
        outcome: 'queue' as const,
        position: queuePosition
      }
    }
    projectActive += 1
    globalActive += 1
    return {
      agentInstanceId: agent!.agentInstanceId,
      outcome: 'start' as const
    }
  })

  return {
    ok: true,
    plan: {
      revision: snapshot.revision,
      projectId: project.projectId,
      entries
    }
  }
}
