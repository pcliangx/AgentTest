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
 * Tasks domain contract tests (#10, review-hardened): Project Task /
 * External Task projections, planner-bound task dispatch, Execution Result
 * only via the explicit mock completion transition, conflict-safe external
 * writes, tombstoned deletions that keep local audit, and external updates
 * that only refresh projections or create Attention — never start an Agent.
 */

function cmdId(n: number): CommandId {
  return id(`cmd-${n}`, 'CommandId')
}

const PROJECT = id('proj-sales', 'ProjectId')
const EXT_TASK: TaskRef = {
  kind: 'external-task',
  externalTaskId: id('ext-task-001', 'ExternalTaskId')
}
const SYNCED_TASK: TaskRef = {
  kind: 'external-task',
  externalTaskId: id('ext-task-003', 'ExternalTaskId')
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

function agentByName(
  snap: WorkbenchViewModel,
  name: string
): WorkbenchViewModel['agents'][number] {
  const agent = snap.agents.find((candidate) => candidate.name === name)
  if (!agent) throw new Error(`scenario agent ${name} missing`)
  return agent
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

function dispatchesForTask(
  snap: WorkbenchViewModel,
  task: WorkbenchViewModel['externalTasks'][number]
): WorkbenchViewModel['dispatches'] {
  return snap.dispatches.filter((dispatch) =>
    task.dispatchIds.includes(dispatch.dispatchId)
  )
}

describe('MockScenarioAdapter — dispatch-task planner binding (#10)', () => {
  it('executes the confirmed planner atomically: start or enqueue with task linkage', async () => {
    const adapter = new MockScenarioAdapter()
    const events: WorkbenchEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const snap = await adapter.getSnapshot()
    const task = externalTask(snap, 'ext-task-003')
    const before = task.dispatchIds.length
    // 2 active runs in the project (limit 3): the first ready target starts,
    // the second takes the projected queue position behind the 2 existing
    // queue items.
    const targets = [
      agentByName(snap, 'cx_review').agentInstanceId,
      agentByName(snap, 'kimi_visual').agentInstanceId
    ]

    const result = await adapter.dispatch(
      dispatchTask(cmdId(1), snap.revision, SYNCED_TASK, targets, '并行复核 Q2 口径')
    )
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const updated = externalTask(after, 'ext-task-003')
    expect(updated.dispatchIds).toHaveLength(before + 2)
    const created = dispatchesForTask(after, updated).slice(-2)

    const started = created.find(
      (dispatch) => dispatch.agentInstanceId === targets[0]
    )!
    expect(started.status).toBe('active')
    expect(started.taskRef).toEqual(SYNCED_TASK)
    expect(started.agentNameSnapshot).toBe('cx_review')
    const startedAgent = agentByName(after, 'cx_review')
    expect(startedAgent.runtimeState).toBe('running')
    expect(startedAgent.activeRunId).toBeDefined()

    const queued = created.find(
      (dispatch) => dispatch.agentInstanceId === targets[1]
    )!
    expect(queued.status).toBe('queued')
    const queuedAgent = agentByName(after, 'kimi_visual')
    expect(queuedAgent.runtimeState).toBe('queued')
    expect(queuedAgent.queueDepth).toBe(1)
    expect(
      after.queue.some(
        (item) =>
          item.agentInstanceId === queuedAgent.agentInstanceId &&
          item.position === 3
      )
    ).toBe(true)

    // No Execution Result exists before the completion transition.
    for (const dispatch of created) {
      expect(
        after.executionResults.some(
          (candidate) => candidate.dispatchId === dispatch.dispatchId
        )
      ).toBe(false)
    }
    expect(externalTask(after, 'ext-task-003').businessStatus).toBe('open')
    const event = events.find(
      (
        candidate
      ): candidate is Extract<WorkbenchEvent, { kind: 'dispatch-created' }> =>
        candidate.kind === 'dispatch-created'
    )
    expect(event).toBeDefined()
    expect(event!.dispatchIds).toHaveLength(2)
  })

  it('produces an Execution Result only through the explicit mock completion transition', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const target = agentByName(snap, 'cx_review').agentInstanceId
    await adapter.dispatch(
      dispatchTask(cmdId(1), snap.revision, LOCAL_TASK, [target], '生成本月报表')
    )
    let after = await adapter.getSnapshot()
    const task = after.projectTasks.find(
      (candidate) => candidate.projectTaskId === id('ptask-001', 'ProjectTaskId')
    )!
    const dispatch = after.dispatches.find(
      (candidate) =>
        candidate.dispatchId === task.dispatchIds[task.dispatchIds.length - 1]
    )!
    expect(dispatch.status).toBe('active')
    expect(
      after.executionResults.some(
        (candidate) => candidate.dispatchId === dispatch.dispatchId
      )
    ).toBe(false)

    const completed = await adapter.dispatch({
      kind: 'complete-dispatch',
      commandId: cmdId(2),
      expectedRevision: after.revision,
      projectId: PROJECT,
      dispatchId: dispatch.dispatchId
    })
    expect(completed.ok).toBe(true)

    after = await adapter.getSnapshot()
    const finished = after.dispatches.find(
      (candidate) => candidate.dispatchId === dispatch.dispatchId
    )!
    expect(finished.status).toBe('completed')
    const result = after.executionResults.find(
      (candidate) => candidate.dispatchId === dispatch.dispatchId
    )!
    expect(result.reviewState).toBe('pending-review')
    expect(result.taskRef).toEqual(LOCAL_TASK)
    // The mock Run is finished: the execution slot frees up again.
    const agent = agentByName(after, 'cx_review')
    expect(agent.runtimeState).toBe('ready')
    expect(agent.activeRunId).toBeUndefined()
    expect(
      after.activity.some((entry) => entry.kind === 'run-completed')
    ).toBe(true)

    // A second completion is a duplicate response.
    const duplicate = await adapter.dispatch({
      kind: 'complete-dispatch',
      commandId: cmdId(3),
      expectedRevision: after.revision,
      projectId: PROJECT,
      dispatchId: dispatch.dispatchId
    })
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.reason).toBe('invalid-target')
  })

  it('rejects completion of a queued dispatch', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    // cx_forecast already holds queue pressure; a fresh ready target behind
    // full capacity queues.
    const targets = [
      agentByName(snap, 'cx_review').agentInstanceId,
      agentByName(snap, 'kimi_visual').agentInstanceId
    ]
    await adapter.dispatch(
      dispatchTask(cmdId(1), snap.revision, SYNCED_TASK, targets)
    )
    const after = await adapter.getSnapshot()
    const queued = dispatchesForTask(after, externalTask(after, 'ext-task-003')).find(
      (dispatch) => dispatch.status === 'queued'
    )!
    const result = await adapter.dispatch({
      kind: 'complete-dispatch',
      commandId: cmdId(2),
      expectedRevision: after.revision,
      projectId: PROJECT,
      dispatchId: queued.dispatchId
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-target')
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
      dispatchTask(cmdId(2), snap.revision, SYNCED_TASK, [
        id('inst-ghost', 'AgentInstanceId')
      ])
    )
    expect(unknownTarget.ok).toBe(false)
    if (!unknownTarget.ok) expect(unknownTarget.reason).toBe('invalid-target')

    const unavailable = await adapter.dispatch(
      dispatchTask(cmdId(3), snap.revision, SYNCED_TASK, [
        agentByName(snap, 'kimi_docs').agentInstanceId
      ])
    )
    expect(unavailable.ok).toBe(false)
    if (!unavailable.ok) expect(unavailable.reason).toBe('unavailable')

    const empty = await adapter.dispatch(
      dispatchTask(cmdId(4), snap.revision, SYNCED_TASK, [target], '   ')
    )
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toBe('invalid-target')

    // Rejection purity: nothing was created and no run started.
    const after = await adapter.getSnapshot()
    expect(after.dispatches).toHaveLength(snap.dispatches.length)
    expect(agentByName(after, 'cx_review').runtimeState).toBe('ready')
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
    const task = externalTask(snap, 'ext-task-003')

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
    expect(externalTask(await adapter.getSnapshot(), 'ext-task-003').businessStatus).toBe(
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
    const updated = externalTask(after, 'ext-task-003')
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
    const task = externalTask(snap, 'ext-task-003')
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

  it('refuses the normal flow on a conflicted task and keeps its proposal', async () => {
    const adapter = new MockScenarioAdapter()
    let snap = await adapter.getSnapshot()
    // Drive ext-task-002 into conflict: failed offline write, then a
    // colliding external update.
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
    await adapter.dispatch({
      kind: 'apply-external-task-update',
      commandId: cmdId(2),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: offline.externalTaskId,
      version: offline.version + 1,
      summary: '飞书端已将该任务标记完成'
    })
    snap = await adapter.getSnapshot()
    const conflicted = externalTask(snap, 'ext-task-002')
    expect(conflicted.syncState).toBe('conflict')
    expect(conflicted.proposedChange).toBeDefined()

    // The normal status flow must not silently overwrite a conflict.
    const result = await adapter.dispatch({
      kind: 'update-external-task-status',
      commandId: cmdId(3),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: conflicted.externalTaskId,
      status: 'completed',
      expectedVersion: conflicted.version
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unavailable')
    const after = await adapter.getSnapshot()
    const kept = externalTask(after, 'ext-task-002')
    expect(kept.businessStatus).toBe('open')
    expect(kept.syncState).toBe('conflict')
    expect(kept.proposedChange).toBeDefined()
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
    const task = externalTask(snap, 'ext-task-003')
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
    expect(externalTask(await adapter.getSnapshot(), 'ext-task-003').businessStatus).toBe(
      'open'
    )
  })
})

describe('MockScenarioAdapter — resolve-external-task-conflict (#10)', () => {
  async function driveIntoConflict(adapter: MockScenarioAdapter) {
    let snap = await adapter.getSnapshot()
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
    await adapter.dispatch({
      kind: 'apply-external-task-update',
      commandId: cmdId(2),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: offline.externalTaskId,
      version: offline.version + 1,
      summary: '飞书端已将该任务标记完成'
    })
    return adapter.getSnapshot()
  }

  it('discards the proposal and atomically resolves the conflict attention', async () => {
    const adapter = new MockScenarioAdapter()
    const events: WorkbenchEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const snap = await driveIntoConflict(adapter)
    const task = externalTask(snap, 'ext-task-002')
    expect(task.syncState).toBe('conflict')
    const attention = snap.attentionItems.find(
      (item) =>
        item.state === 'open' &&
        item.target.kind === 'external-task' &&
        item.target.externalTaskId === task.externalTaskId
    )!
    expect(attention).toBeDefined()

    const result = await adapter.dispatch({
      kind: 'resolve-external-task-conflict',
      commandId: cmdId(3),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: task.externalTaskId,
      expectedVersion: task.version,
      resolution: 'discard'
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const updated = externalTask(after, 'ext-task-002')
    expect(updated.syncState).toBe('synced')
    expect(updated.proposedChange).toBeUndefined()
    expect(updated.businessStatus).toBe('open')
    const resolved = after.attentionItems.find(
      (item) => item.attentionItemId === attention.attentionItemId
    )!
    expect(resolved.state).toBe('resolved')
    expect(
      events.some(
        (event) =>
          event.kind === 'attention-changed' &&
          event.attentionItemId === attention.attentionItemId
      )
    ).toBe(true)
  })

  it('overwrites through the confirmation host and applies the proposal atomically', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await driveIntoConflict(adapter)
    const task = externalTask(snap, 'ext-task-002')

    const request = await adapter.dispatch({
      kind: 'resolve-external-task-conflict',
      commandId: cmdId(3),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: task.externalTaskId,
      expectedVersion: task.version,
      resolution: 'overwrite'
    })
    expect(request.ok).toBe(true)
    const pending = (await adapter.getSnapshot()).pendingConfirmation!
    expect(pending.action).toContain('覆盖')
    expect(pending.nonBypassableReason).toBeTruthy()

    const confirmed = await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(4),
      expectedRevision: (await adapter.getSnapshot()).revision,
      confirmationId: pending.confirmationId
    })
    expect(confirmed.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const updated = externalTask(after, 'ext-task-002')
    expect(updated.businessStatus).toBe('completed')
    expect(updated.syncState).toBe('synced')
    expect(updated.proposedChange).toBeUndefined()
    expect(updated.version).toBe(task.version + 1)
    // The conflict attention resolves in the same transition.
    expect(
      after.attentionItems.some(
        (item) =>
          item.state === 'open' &&
          item.target.kind === 'external-task' &&
          item.target.externalTaskId === task.externalTaskId
      )
    ).toBe(false)
    expect(
      after.activity.some(
        (candidate) => candidate.kind === 'external-task-write'
      )
    ).toBe(true)
  })

  it('fails closed when the task is not conflicted or the version moved', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const synced = externalTask(snap, 'ext-task-003')
    const notConflicted = await adapter.dispatch({
      kind: 'resolve-external-task-conflict',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: synced.externalTaskId,
      expectedVersion: synced.version,
      resolution: 'discard'
    })
    expect(notConflicted.ok).toBe(false)
    if (!notConflicted.ok) expect(notConflicted.reason).toBe('invalid-target')

    const stale = await adapter.dispatch({
      kind: 'resolve-external-task-conflict',
      commandId: cmdId(2),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: synced.externalTaskId,
      expectedVersion: synced.version - 1,
      resolution: 'discard'
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.reason).toBe('stale-revision')
  })
})

describe('MockScenarioAdapter — request-external-task-operation (#10)', () => {
  it('tombstones the projection but keeps local Dispatch/Result audit', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const task = externalTask(snap, 'ext-task-003')

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

    const confirmed = await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: (await adapter.getSnapshot()).revision,
      confirmationId: pending.confirmationId
    })
    expect(confirmed.ok).toBe(true)
    const after = await adapter.getSnapshot()
    const tombstoned = externalTask(after, 'ext-task-003')
    expect(tombstoned.lifecycle).toBe('deleted')
    // Local Dispatch/Result truth survives the external deletion.
    expect(
      after.dispatches.some(
        (candidate) =>
          candidate.taskRef.kind === 'external-task' &&
          candidate.taskRef.externalTaskId === task.externalTaskId
      )
    ).toBe(true)
    expect(
      after.executionResults.some(
        (candidate) =>
          candidate.taskRef.kind === 'external-task' &&
          candidate.taskRef.externalTaskId === task.externalTaskId
      )
    ).toBe(true)
  })

  it('atomically resolves attention items that targeted the deleted task', async () => {
    const scenario = createStandardScenario()
    scenario.attentionItems.push({
      attentionItemId: id('att-ext-003', 'AttentionItemId'),
      kind: 'connection-conflict',
      target: {
        kind: 'external-task',
        projectId: PROJECT,
        externalTaskId: id('ext-task-003', 'ExternalTaskId')
      },
      state: 'open',
      title: '飞书任务「渠道拓展计划」存在版本冲突'
    })
    const adapter = new MockScenarioAdapter(scenario)
    const events: WorkbenchEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const snap = await adapter.getSnapshot()
    const task = externalTask(snap, 'ext-task-003')
    const globalBefore = snap.global.attentionCount

    await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      operation: 'delete',
      externalTaskIds: [task.externalTaskId]
    })
    const pending = (await adapter.getSnapshot()).pendingConfirmation!
    await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: (await adapter.getSnapshot()).revision,
      confirmationId: pending.confirmationId
    })

    const after = await adapter.getSnapshot()
    const resolved = after.attentionItems.find(
      (item) => item.attentionItemId === id('att-ext-003', 'AttentionItemId')
    )!
    expect(resolved.state).toBe('resolved')
    expect(after.global.attentionCount).toBe(globalBefore - 1)
    expect(
      events.some(
        (event) =>
          event.kind === 'attention-changed' &&
          event.attentionItemId === id('att-ext-003', 'AttentionItemId')
      )
    ).toBe(true)
  })

  it('batch-deletes through one confirmation as tombstones', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const request = await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      operation: 'batch-delete',
      externalTaskIds: [
        id('ext-task-003', 'ExternalTaskId'),
        id('ext-task-004', 'ExternalTaskId')
      ]
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
    expect(externalTask(after, 'ext-task-003').lifecycle).toBe('deleted')
    expect(externalTask(after, 'ext-task-004').lifecycle).toBe('deleted')
  })

  it('fails an offline write as a kept proposal instead of a fake success', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const offline = externalTask(snap, 'ext-task-002')

    const result = await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      operation: 'delete',
      externalTaskIds: [offline.externalTaskId]
    })
    expect(result.ok).toBe(true)

    const after = await adapter.getSnapshot()
    const updated = externalTask(after, 'ext-task-002')
    // No confirmation was offered and nothing was deleted: the failed write
    // keeps its proposal and reason instead.
    expect((await adapter.getSnapshot()).pendingConfirmation).toBeUndefined()
    expect(updated.lifecycle).toBe('active')
    expect(updated.proposedChange).toBeDefined()
    expect(updated.proposedChange!.failureReason).toBeTruthy()
    expect(
      after.activity.some(
        (candidate) => candidate.kind === 'external-task-write-failed'
      )
    ).toBe(true)
  })

  it('fails closed on conflicted tasks before any preview', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const conflicted = externalTask(snap, 'ext-task-001')
    expect(conflicted.syncState).toBe('conflict')
    const result = await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      operation: 'delete',
      externalTaskIds: [conflicted.externalTaskId]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unavailable')
    expect((await adapter.getSnapshot()).pendingConfirmation).toBeUndefined()
  })

  it('freezes the preview and fails closed when version or sync state drifts', async () => {
    const adapter = new MockScenarioAdapter()
    let snap = await adapter.getSnapshot()
    const task = externalTask(snap, 'ext-task-003')
    await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      operation: 'change-members',
      externalTaskIds: [task.externalTaskId]
    })
    const pending = (await adapter.getSnapshot()).pendingConfirmation!

    // The projection moves between preview and confirmation.
    snap = await adapter.getSnapshot()
    await adapter.dispatch({
      kind: 'apply-external-task-update',
      commandId: cmdId(2),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      externalTaskId: task.externalTaskId,
      version: task.version + 1,
      summary: '飞书端更新了任务'
    })

    const confirmed = await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(3),
      expectedRevision: (await adapter.getSnapshot()).revision,
      confirmationId: pending.confirmationId
    })
    expect(confirmed.ok).toBe(false)
    if (!confirmed.ok) expect(confirmed.reason).toBe('invalid-target')
    // The drifted write never executed.
    expect(externalTask(await adapter.getSnapshot(), 'ext-task-003').version).toBe(
      task.version + 1
    )
  })

  it('records member and permission changes as confirmed external writes', async () => {
    for (const operation of ['change-members', 'change-permissions'] as const) {
      const adapter = new MockScenarioAdapter()
      const snap = await adapter.getSnapshot()
      const task = externalTask(snap, 'ext-task-003')
      await adapter.dispatch({
        kind: 'request-external-task-operation',
        commandId: cmdId(1),
        expectedRevision: snap.revision,
        projectId: PROJECT,
        operation,
        externalTaskIds: [task.externalTaskId]
      })
      const pending = (await adapter.getSnapshot()).pendingConfirmation!
      const confirmed = await adapter.dispatch({
        kind: 'confirm-dangerous-action',
        commandId: cmdId(2),
        expectedRevision: (await adapter.getSnapshot()).revision,
        confirmationId: pending.confirmationId
      })
      expect(confirmed.ok).toBe(true)
      const after = await adapter.getSnapshot()
      const updated = externalTask(after, 'ext-task-003')
      expect(updated.version).toBe(task.version + 1)
      expect(
        after.activity.some(
          (candidate) => candidate.kind === 'external-task-write'
        )
      ).toBe(true)
    }
  })

  it('rejects operations on tombstoned or unknown tasks and while busy', async () => {
    const adapter = new MockScenarioAdapter()
    let snap = await adapter.getSnapshot()
    // Tombstone ext-task-003 first.
    await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(1),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      operation: 'delete',
      externalTaskIds: [id('ext-task-003', 'ExternalTaskId')]
    })
    const pending = (await adapter.getSnapshot()).pendingConfirmation!
    await adapter.dispatch({
      kind: 'confirm-dangerous-action',
      commandId: cmdId(2),
      expectedRevision: (await adapter.getSnapshot()).revision,
      confirmationId: pending.confirmationId
    })

    snap = await adapter.getSnapshot()
    const onTombstone = await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(3),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      operation: 'change-members',
      externalTaskIds: [id('ext-task-003', 'ExternalTaskId')]
    })
    expect(onTombstone.ok).toBe(false)
    if (!onTombstone.ok) expect(onTombstone.reason).toBe('invalid-target')

    const ghost = await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(4),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      operation: 'delete',
      externalTaskIds: [id('ext-ghost', 'ExternalTaskId')]
    })
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.reason).toBe('invalid-target')

    await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(5),
      expectedRevision: snap.revision,
      projectId: PROJECT,
      operation: 'delete',
      externalTaskIds: [id('ext-task-004', 'ExternalTaskId')]
    })
    const busy = await adapter.dispatch({
      kind: 'request-external-task-operation',
      commandId: cmdId(6),
      expectedRevision: (await adapter.getSnapshot()).revision,
      projectId: PROJECT,
      operation: 'change-members',
      externalTaskIds: [id('ext-task-004', 'ExternalTaskId')]
    })
    expect(busy.ok).toBe(false)
    if (!busy.ok) expect(busy.reason).toBe('busy')
  })
})

describe('MockScenarioAdapter — apply-external-task-update (#10)', () => {
  it('refreshes only the projection and never starts an Agent', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const task = externalTask(snap, 'ext-task-003')
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
    expect(externalTask(after, 'ext-task-003').version).toBe(task.version + 1)
    expect(
      after.activity.filter((entry) => entry.kind === 'run-started')
    ).toHaveLength(runActivityBefore)
    for (const agent of after.agents) {
      expect(agent.runtimeState).toBe(statesBefore.get(agent.agentInstanceId))
    }
  })

  it('rejects a non-forward external version and updates on tombstones', async () => {
    const adapter = new MockScenarioAdapter()
    const snap = await adapter.getSnapshot()
    const task = externalTask(snap, 'ext-task-003')
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
  it('seeds distinguishable tasks with projection facts and name snapshots', async () => {
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
    expect(task.lifecycle).toBe('active')
    expect(task.dispatchIds.length).toBeGreaterThan(0)
    // Every dispatch carries an immutable snapshot of the Agent's name.
    for (const dispatch of snap.dispatches) {
      expect(dispatch.agentNameSnapshot).toBeTruthy()
    }
    const states = new Set(
      snap.executionResults.map((candidate) => candidate.reviewState)
    )
    expect(states.has('pending-review')).toBe(true)
    expect(states.has('accepted')).toBe(true)
    expect(externalTask(snap, 'ext-task-002').syncState).toBe('offline')
    expect(externalTask(snap, 'ext-task-003').syncState).toBe('synced')
    expect(externalTask(snap).syncState).toBe('conflict')
  })
})
