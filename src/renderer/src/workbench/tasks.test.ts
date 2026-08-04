import { describe, it, expect } from 'vitest'
import { MockScenarioAdapter } from './mock-scenario-adapter'
import { id } from './contract'
import { createStandardScenario } from './standard-scenario'
import type {
  CommandId,
  TaskRef,
  WorkbenchCommand,
  WorkbenchEvent,
  WorkbenchViewModel
} from './contract'

/**
 * Tasks domain contract tests (#10): Project Task / External Task
 * projections, per-target Dispatch + Execution Result records, user review
 * and acceptance, explicit external business writes through the shared
 * confirmation host, and external updates that only ever refresh
 * projections or create Attention — never start an Agent.
 */

function cmdId(n: number): CommandId {
  return id(`cmd-${n}`, 'CommandId')
}

const PROJECT = id('proj-sales', 'ProjectId')
const EXT_TASK: TaskRef = {
  kind: 'external-task',
  externalTaskId: id('ext-task-001', 'ExternalTaskId')
}
const LOCAL_TASK: TaskRef = {
  kind: 'project-task',
  projectTaskId: id('ptask-001', 'ProjectTaskId')
}

function externalTask(
  snap: WorkbenchViewModel,
  externalTaskId = 'ext-task-001'
): WorkbenchViewModel['externalTasks'][number] {
  const task = snap.externalTasks.find(
    (candidate) =>
      candidate.externalTaskId === id(externalTaskId, 'ExternalTaskId')
  )
  if (!task) throw new Error(`scenario external task ${externalTaskId} missing`)
  return task
}

function dispatchTask(
  commandId: CommandId,
  expectedRevision: number,
  taskRef: TaskRef,
  targets: WorkbenchViewModel['agents'][number]['agentInstanceId'][],
  instruction = '处理该任务'
): WorkbenchCommand {
  return {
    kind: 'dispatch-task',
    commandId,
    expectedRevision,
    projectId: PROJECT,
    taskRef,
    targets,
    instruction
  }
}

function agentByName(
  snap: WorkbenchViewModel,
  name: string
): WorkbenchViewModel['agents'][number] {
  const agent = snap.agents.find((candidate) => candidate.name === name)
  if (!agent) throw new Error(`scenario agent ${name} missing`)
  return agent
}

describe('MockScenarioAdapter — dispatch-task (#10)', () => {
  it('creates an independent Dispatch and pending-review Execution Result per target', async () => {
    const adapter = new MockScenarioAdapter()
    const events: WorkbenchEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const snap = await adapter.getSnapshot()
    const task = externalTask(snap)
    const before = task.dispatchIds.length
    const targets = [
      agentByName(snap, 'cx_review').agentInstanceId,
      agentByName(snap, 'kimi_visual').agentInstanceId
    ]

    const result = await adapter.dispatch(
      dispatchTask(cmdId(1), snap.revision, EXT_TASK, targets, '并行调研 Q2 口径')
    )
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const updated = externalTask(after)
    expect(updated.dispatchIds).toHaveLength(before + 2)
    const created = after.dispatches.filter((dispatch) =>
      updated.dispatchIds.slice(before).includes(dispatch.dispatchId)
    )
    expect(created).toHaveLength(2)
    // One independent result per target, both awaiting user review.
    for (const dispatch of created) {
      const resultForDispatch = after.executionResults.find(
        (candidate) => candidate.dispatchId === dispatch.dispatchId
      )
      expect(resultForDispatch).toBeDefined()
      expect(resultForDispatch!.reviewState).toBe('pending-review')
      expect(resultForDispatch!.taskRef).toEqual(EXT_TASK)
    }
    // A Run completing never marks the External Task business-complete.
    expect(updated.businessStatus).toBe('open')
    const event = events.find(
      (
        candidate
      ): candidate is Extract<WorkbenchEvent, { kind: 'dispatch-created' }> =>
        candidate.kind === 'dispatch-created'
    )
    expect(event).toBeDefined()
    expect(event!.dispatchIds).toHaveLength(2)
  })

  it('also dispatches a local Project Task to a single Agent', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const target = agentByName(snap, 'cx_review').agentInstanceId
    const result = await adapter.dispatch(
      dispatchTask(cmdId(1), snap.revision, LOCAL_TASK, [target], '生成本月报表')
    )
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const task = after.projectTasks.find(
      (candidate) =>
        candidate.projectTaskId === id('ptask-001', 'ProjectTaskId')
    )!
    expect(task.dispatchIds.length).toBeGreaterThan(0)
    const dispatch = after.dispatches.find(
      (candidate) =>
        candidate.dispatchId === task.dispatchIds[task.dispatchIds.length - 1]
    )!
    expect(dispatch.taskRef).toEqual(LOCAL_TASK)
  })

  it('rejects unknown tasks, unknown or unavailable targets and empty input', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const target = agentByName(snap, 'cx_review').agentInstanceId

    const unknownTask = await adapter.dispatch(
      dispatchTask(
        cmdId(1),
        snap.revision,
        {
          kind: 'external-task',
          externalTaskId: id('ext-ghost', 'ExternalTaskId')
        },
        [target]
      )
    )
    expect(unknownTask.ok).toBe(false)
    if (!unknownTask.ok) expect(unknownTask.reason).toBe('invalid-target')

    const unknownTarget = await adapter.dispatch(
      dispatchTask(cmdId(2), snap.revision, EXT_TASK, [
        id('inst-ghost', 'AgentInstanceId')
      ])
    )
    expect(unknownTarget.ok).toBe(false)
    if (!unknownTarget.ok) expect(unknownTarget.reason).toBe('invalid-target')

    const unavailable = await adapter.dispatch(
      dispatchTask(cmdId(3), snap.revision, EXT_TASK, [
        agentByName(snap, 'kimi_docs').agentInstanceId
      ])
    )
    expect(unavailable.ok).toBe(false)
    if (!unavailable.ok) expect(unavailable.reason).toBe('unavailable')

    const empty = await adapter.dispatch(
      dispatchTask(cmdId(4), snap.revision, EXT_TASK, [target], '   ')
    )
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toBe('invalid-target')

    // Rejection purity: nothing was created.
    const after = await adapter.getSnapshot()
    expect(after.dispatches).toHaveLength(snap.dispatches.length)
  })

  it('never starts an Agent as a side effect of a task dispatch', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const runActivityBefore = snap.activity.filter(
      (entry) => entry.kind === 'run-started'
    ).length
    const statesBefore = new Map(
      snap.agents.map((agent) => [agent.agentInstanceId, agent.runtimeState])
    )
    const target = agentByName(snap, 'cx_review').agentInstanceId

    await adapter.dispatch(
      dispatchTask(cmdId(1), snap.revision, EXT_TASK, [target])
    )

    const after = await adapter.getSnapshot()
    expect(
      after.activity.filter((entry) => entry.kind === 'run-started')
    ).toHaveLength(runActivityBefore)
    for (const agent of after.agents) {
      expect(agent.runtimeState).toBe(statesBefore.get(agent.agentInstanceId))
    }
    expect(after.global.concurrency.activeGlobal).toBe(
      snap.global.concurrency.activeGlobal
    )
  })
})

describe('MockScenarioAdapter — review-execution-result (#10)', () => {
  it('accepts a pending result and records the review without touching business status', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const pending = snap.executionResults.find(
      (candidate) => candidate.reviewState === 'pending-review'
    )!
    expect(pending).toBeDefined()

    const result = await adapter.dispatch({
      kind: 'review-execution-result',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      resultId: pending.resultId,
      decision: 'accept'
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const reviewed = after.executionResults.find(
      (candidate) => candidate.resultId === pending.resultId
    )!
    expect(reviewed.reviewState).toBe('accepted')
    expect(reviewed.reviewedAt).toBeDefined()
    const entry = after.activity.find(
      (candidate) => candidate.kind === 'execution-result-reviewed'
    )!
    expect(entry.summary).toContain('已验收')
    // User acceptance of a result is still not the External Task's business
    // completion — that stays an explicit separate action.
    expect(externalTask(after).businessStatus).toBe('open')
  })

  it('requests revision on a pending result', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const pending = snap.executionResults.find(
      (candidate) => candidate.reviewState === 'pending-review'
    )!
    const result = await adapter.dispatch({
      kind: 'review-execution-result',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      resultId: pending.resultId,
      decision: 'request-revision'
    })
    expect(result.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(
      after.executionResults.find(
        (candidate) => candidate.resultId === pending.resultId
      )!.reviewState
    ).toBe('revision-requested')
    const entry = after.activity.find(
      (candidate) => candidate.kind === 'execution-result-reviewed'
    )!
    expect(entry.summary).toContain('已提出修订')
  })

  it('rejects reviewing an already-reviewed result', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const accepted = snap.executionResults.find(
      (candidate) => candidate.reviewState === 'accepted'
    )!
    const result = await adapter.dispatch({
      kind: 'review-execution-result',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      resultId: accepted.resultId,
      decision: 'accept'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })
})

describe('MockScenarioAdapter — update-external-task-status (#10)', () => {
  it('requires the shared confirmation host for the explicit business write', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const task = externalTask(snap)

    const request = await adapter.dispatch({
      kind: 'update-external-task-status',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: task.externalTaskId,
      status: 'completed',
      expectedVersion: task.version
    })
    expect(request.ok).toBe(true)
    const pending = (await adapter.getSnapshot()).pendingConfirmation
    expect(pending).toBeDefined()
    expect(pending!.action).toContain('飞书任务')
    expect(pending!.nonBypassableReason).toBeTruthy()
    // Nothing changed yet — the business write waits for confirmation.
    expect(externalTask(await adapter.getSnapshot()).businessStatus).toBe(
      'open'
    )

    const confirmed = await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: (await adapter.getSnapshot()).revision,
      confirmationId: pending!.confirmationId
    })
    expect(confirmed.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const updated = externalTask(after)
    expect(updated.businessStatus).toBe('completed')
    expect(updated.version).toBe(task.version + 1)
    expect(
      after.activity.some(
        (candidate) => candidate.kind === 'external-task-write'
      )
    ).toBe(true)
  })

  it('rejects a stale projection version before any confirmation', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const task = externalTask(snap)
    const result = await adapter.dispatch({
      kind: 'update-external-task-status',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: task.externalTaskId,
      status: 'completed',
      expectedVersion: task.version - 1
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('stale-revision')
    expect((await adapter.getSnapshot()).pendingConfirmation).toBeUndefined()
  })

  it('keeps the proposed change and failure reason when the external write fails', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const offline = externalTask(snap, 'ext-task-002')
    expect(offline.syncState).toBe('offline')

    const result = await adapter.dispatch({
      kind: 'update-external-task-status',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: offline.externalTaskId,
      status: 'completed',
      expectedVersion: offline.version
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const updated = externalTask(after, 'ext-task-002')
    // The write failed externally: business status is untouched, but the
    // proposal and its reason survive for the user.
    expect(updated.businessStatus).toBe('open')
    expect(updated.proposedChange).toBeDefined()
    expect(updated.proposedChange!.failureReason).toBeTruthy()
    expect(
      after.activity.some(
        (candidate) => candidate.kind === 'external-task-write-failed'
      )
    ).toBe(true)
  })

  it('expires the status preview when the task version moves before confirmation', async () => {
    const adapter = new MockScenarioAdapter()
    let snap = await adapter.getSnapshot()
    const task = externalTask(snap)
    await adapter.dispatch({
      kind: 'update-external-task-status',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: task.externalTaskId,
      status: 'completed',
      expectedVersion: task.version
    })
    const pending = (await adapter.getSnapshot()).pendingConfirmation!

    // An external update lands before the user confirms.
    snap = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'apply-external-task-update',
      commandId: cmdId(2),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: task.externalTaskId,
      version: task.version + 1,
      summary: '飞书端更新了任务描述'
    })

    const confirmed = await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(3),
      expectedRevision: (await adapter.getSnapshot()).revision,
      confirmationId: pending.confirmationId
    })
    expect(confirmed.ok).toBe(false)
    if (!confirmed.ok) expect(confirmed.reason).toBe('invalid-target')
    expect(externalTask(await adapter.getSnapshot()).businessStatus).toBe(
      'open'
    )
  })
})

describe('MockScenarioAdapter — request-external-task-operation (#10)', () => {
  it('routes deletion through the shared confirmation host and removes linked records', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const task = externalTask(snap)

    const request = await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      operation: 'delete',
      externalTaskIds: [task.externalTaskId]
    })
    expect(request.ok).toBe(true)
    const pending = (await adapter.getSnapshot()).pendingConfirmation!
    expect(pending.action).toContain('删除')
    expect(pending.target).toContain(task.title)
    expect(pending.impact).toBeTruthy()
    expect(pending.nonBypassableReason).toBeTruthy()

    const confirmed = await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: (await adapter.getSnapshot()).revision,
      confirmationId: pending.confirmationId
    })
    expect(confirmed.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(
      after.externalTasks.some(
        (candidate) => candidate.externalTaskId === task.externalTaskId
      )
    ).toBe(false)
    // Linked Dispatch/Result records die with the projection.
    expect(
      after.dispatches.some(
        (candidate) =>
          candidate.taskRef.kind === 'external-task' &&
          candidate.taskRef.externalTaskId === task.externalTaskId
      )
    ).toBe(false)
    expect(
      after.executionResults.some(
        (candidate) =>
          candidate.taskRef.kind === 'external-task' &&
          candidate.taskRef.externalTaskId === task.externalTaskId
      )
    ).toBe(false)
  })

  it('batch-deletes multiple tasks through one confirmation', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const ids = [
      id('ext-task-001', 'ExternalTaskId'),
      id('ext-task-002', 'ExternalTaskId')
    ] as const
    const request = await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      operation: 'batch-delete',
      externalTaskIds: [...ids]
    })
    expect(request.ok).toBe(true)
    const pending = (await adapter.getSnapshot()).pendingConfirmation!
    expect(pending.action).toContain('批量删除')
    const confirmed = await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: (await adapter.getSnapshot()).revision,
      confirmationId: pending.confirmationId
    })
    expect(confirmed.ok).toBe(true)
    const after = await adapter.getSnapshot()
    expect(after.externalTasks).toHaveLength(0)
  })

  it('records member and permission changes as confirmed external writes without deleting the task', async () => {
    for (const operation of ['change-members', 'change-permissions'] as const) {
      const adapter = new MockScenarioAdapter()
      const snap = await adapter.getSnapshot()
      const task = externalTask(snap)
      const request = await adapter.dispatch({
        kind: 'request-external-task-operation',
        commandId: cmdId(1),
        expectedRevision: snap.revision,
        projectId: PROJECT,
        operation,
        externalTaskIds: [task.externalTaskId]
      })
      expect(request.ok).toBe(true)
      const pending = (await adapter.getSnapshot()).pendingConfirmation!
      const confirmed = await adapter.dispatch({
        kind: 'confirm-dangerous-action',
        commandId: cmdId(2),
        expectedRevision: (await adapter.getSnapshot()).revision,
        confirmationId: pending.confirmationId
      })
      expect(confirmed.ok).toBe(true)
      const after = await adapter.getSnapshot()
      const updated = externalTask(after)
      expect(updated.version).toBe(task.version + 1)
      expect(
        after.activity.some(
          (candidate) => candidate.kind === 'external-task-write'
        )
      ).toBe(true)
    }
  })

  it('rejects unknown tasks and a second operation while confirmation is pending', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const task = externalTask(snap)
    const ghost = await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      operation: 'delete',
      externalTaskIds: [id('ext-ghost', 'ExternalTaskId')]
    })
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.reason).toBe('invalid-target')
    expect((await adapter.getSnapshot()).pendingConfirmation).toBeUndefined()

    await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(2),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      operation: 'delete',
      externalTaskIds: [task.externalTaskId]
    })
    const busy = await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(3),
      expectedRevision: (await adapter.getSnapshot()).revision,
      projectId: PROJECT,
      operation: 'change-members',
      externalTaskIds: [task.externalTaskId]
    })
    expect(busy.ok).toBe(false)
    if (!busy.ok) expect(busy.reason).toBe('busy')
  })
})

describe('MockScenarioAdapter — apply-external-task-update (#10)', () => {
  it('refreshes only the projection and never starts an Agent', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const task = externalTask(snap)
    const runActivityBefore = snap.activity.filter(
      (entry) => entry.kind === 'run-started'
    ).length
    const statesBefore = new Map(
      snap.agents.map((agent) => [agent.agentInstanceId, agent.runtimeState])
    )

    const result = await adapter.dispatch({
      kind: 'apply-external-task-update',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: task.externalTaskId,
      version: task.version + 1,
      summary: '飞书端更新了任务标题'
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    expect(externalTask(after).version).toBe(task.version + 1)
    expect(
      after.activity.filter((entry) => entry.kind === 'run-started')
    ).toHaveLength(runActivityBefore)
    for (const agent of after.agents) {
      expect(agent.runtimeState).toBe(statesBefore.get(agent.agentInstanceId))
    }
  })

  it('turns a colliding update into conflict plus an Attention item', async () => {
    const adapter = new MockScenarioAdapter()
    let snap = await adapter.getSnapshot()
    // Give the task a pending local proposal first: the offline write failed.
    const offline = externalTask(snap, 'ext-task-002')
    await adapter.dispatch({
      kind: 'update-external-task-status',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: offline.externalTaskId,
      status: 'completed',
      expectedVersion: offline.version
    })
    snap = await adapter.getSnapshot()
    expect(externalTask(snap, 'ext-task-002').proposedChange).toBeDefined()
    const events: WorkbenchEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const attentionBefore = snap.attentionItems.filter(
      (item) => item.state === 'open'
    ).length

    const result = await adapter.dispatch({
      kind: 'apply-external-task-update',
      commandId: cmdId(2),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: offline.externalTaskId,
      version: offline.version + 1,
      summary: '飞书端已将该任务标记完成'
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const updated = externalTask(after, 'ext-task-002')
    expect(updated.syncState).toBe('conflict')
    // The proposal is still kept for the user to resolve.
    expect(updated.proposedChange).toBeDefined()
    const attention = after.attentionItems.find(
      (item) =>
        item.state === 'open' &&
        item.kind === 'connection-conflict' &&
        item.target.kind === 'external-task' &&
        item.target.externalTaskId === offline.externalTaskId
    )
    expect(attention).toBeDefined()
    expect(
      after.attentionItems.filter((item) => item.state === 'open')
    ).toHaveLength(attentionBefore + 1)
    expect(
      events.some(
        (event) =>
          event.kind === 'attention-changed' &&
          event.attentionItemId === attention!.attentionItemId
      )
    ).toBe(true)
  })

  it('rejects a non-forward external version', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const task = externalTask(snap)
    const result = await adapter.dispatch({
      kind: 'apply-external-task-update',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: task.externalTaskId,
      version: task.version,
      summary: '重复投递'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
  })
})

describe('MockScenarioAdapter — tasks scenario data (#10)', () => {
  it('seeds distinguishable local and external tasks with projection facts', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const local = snap.projectTasks.find(
      (candidate) =>
        candidate.projectTaskId === id('ptask-001', 'ProjectTaskId')
    )
    expect(local).toBeDefined()
    expect(local!.title).toBeTruthy()

    const task = externalTask(snap)
    expect(task.externalId).toBeTruthy()
    expect(task.version).toBeGreaterThan(0)
    expect(task.dispatchIds.length).toBeGreaterThan(0)
    // Seeded dispatches expose independent results in distinct review states.
    const states = new Set(
      snap.executionResults.map((candidate) => candidate.reviewState)
    )
    expect(states.has('pending-review')).toBe(true)
    expect(states.has('accepted')).toBe(true)
    // Offline and conflict projections both exist for degradation display.
    expect(externalTask(snap, 'ext-task-002').syncState).toBe('offline')
    expect(['conflict', 'synced']).toContain(task.syncState)
  })
})
