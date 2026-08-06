import { useEffect, useState } from 'react'
import type {
  AttentionTarget,
  CommandResult,
  DispatchId,
  DispatchViewModel,
  ExternalTaskOperation,
  ExternalTaskViewModel,
  ExecutionReviewState,
  ProjectTaskViewModel,
  ProjectViewModel,
  TaskRef,
  TaskSyncState,
  WorkbenchCommandBody,
  WorkbenchViewModel
} from './workbench/contract'
import type { SendCommand } from './agents-surface'
import { StatusChip, type StatusChipTone } from './status-chip'

/**
 * Tasks surface (#10).
 *
 * Local Project Tasks live only inside Agent Squad HQ; Feishu External
 * Tasks are projections — Feishu owns the business fields, the surface
 * shows external ID, version, sync truth, dispatches, independent execution
 * results and the final acceptance state. A Run completing or a result
 * being accepted never completes the business task: that is always an
 * explicit, separately confirmed action. High-risk external operations
 * (delete, batch, members, permissions, business overwrite) all reuse the
 * shell's shared confirmation host.
 *
 * #69: every status renders as color + decorative icon + text through the
 * shared StatusChip (UX-v0.2 §15); danger actions keep their own danger
 * styling and never share an unlabelled icon with everyday actions.
 */

const SYNC_LABEL: Record<TaskSyncState, string> = {
  synced: '已同步',
  offline: '离线',
  conflict: '冲突',
  unavailable: '不可用'
}

const SYNC_CHIP: Record<
  TaskSyncState,
  { tone: StatusChipTone; icon: string }
> = {
  synced: { tone: 'good', icon: '●' },
  offline: { tone: 'neutral', icon: '◌' },
  conflict: { tone: 'warn', icon: '⚠' },
  unavailable: { tone: 'danger', icon: '✕' }
}

const REVIEW_LABEL: Record<ExecutionReviewState, string> = {
  'pending-review': '待评审',
  accepted: '已验收',
  'revision-requested': '已提出修订'
}

const REVIEW_CHIP: Record<
  ExecutionReviewState,
  { tone: StatusChipTone; icon: string }
> = {
  'pending-review': { tone: 'warn', icon: '⚠' },
  accepted: { tone: 'good', icon: '✓' },
  'revision-requested': { tone: 'neutral', icon: '↩' }
}

// Dispatch status is a contract enum of its own (not an AgentRuntimeState),
// so these badges belong to StatusChip, not StatusDot (#69 H1). `completed`
// renders no badge today; its entry keeps the Record exhaustive.
const DISPATCH_STATUS_CHIP: Record<
  DispatchViewModel['status'],
  { label: string; tone: StatusChipTone; icon: string }
> = {
  active: { label: '进行中', tone: 'brand', icon: '●' },
  queued: { label: '排队中', tone: 'neutral', icon: '◌' },
  completed: { label: '已完成', tone: 'good', icon: '✓' },
  cancelled: { label: '已取消', tone: 'warn', icon: '⚠' }
}

const BUSINESS_LABEL: Record<
  ExternalTaskViewModel['businessStatus'],
  string
> = {
  open: '未完成',
  completed: '已完成'
}

const LOCAL_STATUS_LABEL: Record<ProjectTaskViewModel['status'], string> = {
  open: '进行中',
  completed: '已完成'
}

export function TasksSurface({
  project,
  snapshot,
  sendCommand,
  highlightTaskRef,
  onDispatchTask
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  sendCommand: SendCommand
  /** The attention deep-link target to spotlight, if any (#9/#10). */
  highlightTaskRef?: AttentionTarget | null
  /** Opens the unified Dispatch Picker carrying this task's context. */
  onDispatchTask: (taskRef: TaskRef, title: string) => void
}) {
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedForBatch, setSelectedForBatch] = useState<Set<string>>(
    new Set()
  )

  // Tombstoned tasks lose their checkboxes, so prune them from the
  // selection: a settled batch must never leave ghost selections behind
  // that can only error on the next click.
  useEffect(() => {
    const activeIds = new Set(
      snapshot.externalTasks
        .filter((candidate) => candidate.lifecycle === 'active')
        .map((candidate) => candidate.externalTaskId as string)
    )
    setSelectedForBatch((current) => {
      const pruned = new Set([...current].filter((id) => activeIds.has(id)))
      return pruned.size === current.size ? current : pruned
    })
  }, [snapshot.externalTasks])

  const act = async (body: WorkbenchCommandBody): Promise<CommandResult> => {
    const result = await sendCommand(body)
    if (!result.ok) {
      setNotice(
        result.reason === 'stale-revision'
          ? '操作基于过期状态，已刷新最新状态，请重试'
          : result.message
      )
    } else {
      setNotice(null)
    }
    return result
  }

  const projectExternalTasks = snapshot.externalTasks.filter(
    (candidate) => candidate.projectId === project.projectId
  )
  const projectLocalTasks = snapshot.projectTasks.filter(
    (candidate) => candidate.projectId === project.projectId
  )

  const isHighlighted = (taskRef: TaskRef): boolean =>
    (highlightTaskRef?.kind === 'project-task' &&
      taskRef.kind === 'project-task' &&
      highlightTaskRef.projectTaskId === taskRef.projectTaskId) ||
    (highlightTaskRef?.kind === 'external-task' &&
      taskRef.kind === 'external-task' &&
      highlightTaskRef.externalTaskId === taskRef.externalTaskId)

  const toggleBatch = (externalTaskId: string): void => {
    setSelectedForBatch((current) => {
      const next = new Set(current)
      if (next.has(externalTaskId)) next.delete(externalTaskId)
      else next.add(externalTaskId)
      return next
    })
  }

  const renderDispatchResults = (taskRef: TaskRef, dispatchIds: DispatchId[]) => {
    if (dispatchIds.length === 0) {
      return <p className="text-xs text-muted">暂无派发</p>
    }
    return (
      <ul className="space-y-1.5">
        {dispatchIds.map((dispatchId) => {
          const dispatch = snapshot.dispatches.find(
            (candidate) => candidate.dispatchId === dispatchId
          )
          if (!dispatch) return null
          const result = snapshot.executionResults.find(
            (candidate) => candidate.dispatchId === dispatchId
          )
          return (
            <li
              key={dispatchId}
              className="rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs"
            >
              <div className="flex items-center gap-2">
                <span className="text-ink">
                  {dispatch.agentNameSnapshot} · {dispatch.instruction}
                </span>
                {dispatch.status === 'active' && (
                  <>
                    <StatusChip
                      tone={DISPATCH_STATUS_CHIP.active.tone}
                      icon={DISPATCH_STATUS_CHIP.active.icon}
                    >
                      {DISPATCH_STATUS_CHIP.active.label}
                    </StatusChip>
                    <button
                      aria-label={`模拟完成：${dispatch.instruction.slice(0, 12)}`}
                      className="mini-button"
                      onClick={() =>
                        void act({
                          kind: 'complete-dispatch',
                          projectId: project.projectId,
                          dispatchId: dispatch.dispatchId
                        })
                      }
                    >
                      模拟完成
                    </button>
                  </>
                )}
                {dispatch.status === 'queued' && (
                  <StatusChip
                    tone={DISPATCH_STATUS_CHIP.queued.tone}
                    icon={DISPATCH_STATUS_CHIP.queued.icon}
                  >
                    {DISPATCH_STATUS_CHIP.queued.label}
                  </StatusChip>
                )}
                {dispatch.status === 'cancelled' && (
                  <StatusChip
                    tone={DISPATCH_STATUS_CHIP.cancelled.tone}
                    icon={DISPATCH_STATUS_CHIP.cancelled.icon}
                  >
                    {DISPATCH_STATUS_CHIP.cancelled.label}
                  </StatusChip>
                )}
              </div>
              {result && (
                <div className="mt-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-muted">{result.summary}</span>
                    <StatusChip
                      tone={REVIEW_CHIP[result.reviewState].tone}
                      icon={REVIEW_CHIP[result.reviewState].icon}
                    >
                      {REVIEW_LABEL[result.reviewState]}
                    </StatusChip>
                  </div>
                  {result.reviewState === 'pending-review' && (
                    <div className="flex gap-1.5">
                      <button
                        aria-label={`验收：${result.summary.slice(0, 12)}`}
                        className="mini-button text-teal"
                        onClick={() =>
                          void act({
                            kind: 'review-execution-result',
                            projectId: project.projectId,
                            resultId: result.resultId,
                            decision: 'accept'
                          })
                        }
                      >
                        验收
                      </button>
                      <button
                        aria-label={`提出修订：${result.summary.slice(0, 12)}`}
                        className="mini-button text-amber"
                        onClick={() =>
                          void act({
                            kind: 'review-execution-result',
                            projectId: project.projectId,
                            resultId: result.resultId,
                            decision: 'request-revision'
                          })
                        }
                      >
                        提出修订
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    )
  }

  const cardClass = (highlighted: boolean): string =>
    `space-y-2 rounded-xl border px-4 py-3 shadow-card ${
      highlighted
        ? 'border-brand bg-brand-soft ring-1 ring-brand'
        : 'border-line bg-paper'
    }`

  const requestOperation = (
    operation: ExternalTaskOperation,
    externalTaskIds: ExternalTaskViewModel['externalTaskId'][]
  ): void => {
    void act({
      kind: 'request-external-task-operation',
      projectId: project.projectId,
      operation,
      externalTaskIds
    })
  }

  const renderExternalTask = (task: ExternalTaskViewModel) => {
    const taskRef: TaskRef = {
      kind: 'external-task',
      externalTaskId: task.externalTaskId
    }
    const highlighted = isHighlighted(taskRef)
    const tombstoned = task.lifecycle === 'deleted'
    const conflicted = task.syncState === 'conflict'
    return (
      <article
        key={task.externalTaskId}
        data-task-card
        aria-label={`飞书任务：${task.title}`}
        className={cardClass(highlighted)}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {!tombstoned && (
              <input
                type="checkbox"
                aria-label={`选择 ${task.title}`}
                checked={selectedForBatch.has(task.externalTaskId)}
                onChange={() => toggleBatch(task.externalTaskId)}
              />
            )}
            <span className="text-sm text-ink">{task.title}</span>
            {highlighted && (
              <span className="chip chip-brand">
                深链目标
              </span>
            )}
            {tombstoned && (
              <StatusChip tone="danger" icon="✕">
                已删除
              </StatusChip>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="chip">
              {task.externalId} · v{task.version}
            </span>
            <StatusChip
              tone={SYNC_CHIP[task.syncState].tone}
              icon={SYNC_CHIP[task.syncState].icon}
            >
              {SYNC_LABEL[task.syncState]}
            </StatusChip>
            <StatusChip
              tone={task.businessStatus === 'completed' ? 'good' : 'neutral'}
              icon={task.businessStatus === 'completed' ? '✓' : undefined}
            >
              {BUSINESS_LABEL[task.businessStatus]}
            </StatusChip>
          </div>
        </div>

        {task.proposedChange && (
          <div
            role="alert"
            className="space-y-1.5 rounded-lg bg-amber-soft px-2 py-1.5 text-xs text-amber"
          >
            <p>
              <span aria-hidden="true">⚠ </span>
              拟议修改：{task.proposedChange.summary}（
              {task.proposedChange.failureReason}）
            </p>
            {conflicted && !tombstoned && (
              <div className="flex gap-1.5">
                <button
                  className="mini-button"
                  onClick={() =>
                    void act({
                      kind: 'resolve-external-task-conflict',
                      projectId: project.projectId,
                      externalTaskId: task.externalTaskId,
                      expectedVersion: task.version,
                      resolution: 'discard'
                    })
                  }
                >
                  放弃拟议修改
                </button>
                <button
                  className="mini-button text-amber"
                  onClick={() =>
                    void act({
                      kind: 'resolve-external-task-conflict',
                      projectId: project.projectId,
                      externalTaskId: task.externalTaskId,
                      expectedVersion: task.version,
                      resolution: 'overwrite'
                    })
                  }
                >
                  用拟议修改覆盖
                </button>
              </div>
            )}
          </div>
        )}

        {renderDispatchResults(taskRef, task.dispatchIds)}

        {!tombstoned && (
          <div className="flex flex-wrap gap-1.5">
            <button
              className="mini-button"
              onClick={() => onDispatchTask(taskRef, task.title)}
            >
              派发给 Agent
            </button>
            {task.businessStatus === 'open' && (
              <button
                className="mini-button text-teal"
                onClick={() =>
                  void act({
                    kind: 'update-external-task-status',
                    projectId: project.projectId,
                    externalTaskId: task.externalTaskId,
                    status: 'completed',
                    expectedVersion: task.version
                  })
                }
              >
                标记完成
              </button>
            )}
            <button
              className="mini-button"
              onClick={() =>
                requestOperation('change-members', [task.externalTaskId])
              }
            >
              成员
            </button>
            <button
              className="mini-button"
              onClick={() =>
                requestOperation('change-permissions', [task.externalTaskId])
              }
            >
              权限
            </button>
            <button
              className="mini-button mini-button-danger"
              onClick={() => requestOperation('delete', [task.externalTaskId])}
            >
              删除
            </button>
          </div>
        )}
      </article>
    )
  }

  const renderLocalTask = (task: ProjectTaskViewModel) => {
    const taskRef: TaskRef = {
      kind: 'project-task',
      projectTaskId: task.projectTaskId
    }
    const highlighted = isHighlighted(taskRef)
    return (
      <article
        key={task.projectTaskId}
        data-task-card
        aria-label={`本地任务：${task.title}`}
        className={cardClass(highlighted)}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink">{task.title}</span>
          {highlighted && (
            <span className="chip chip-brand">
              深链目标
            </span>
          )}
          <StatusChip
            tone={task.status === 'completed' ? 'good' : 'brand'}
            icon={task.status === 'completed' ? '✓' : '●'}
          >
            {LOCAL_STATUS_LABEL[task.status]}
          </StatusChip>
        </div>
        {renderDispatchResults(taskRef, task.dispatchIds)}
        <div>
          <button
            className="mini-button"
            onClick={() => onDispatchTask(taskRef, task.title)}
          >
            派发给 Agent
          </button>
        </div>
      </article>
    )
  }

  return (
    <section role="region" aria-label="任务" className="space-y-4">
      <h2 className="text-base font-semibold text-ink">任务</h2>
      {notice && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-1.5 text-xs text-danger">
          {notice}
        </p>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-ink">
          本地 Project Task
        </h3>
        {projectLocalTasks.length === 0 ? (
          // #92 spec 5: empty task list — guided entry with action buttons
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line bg-raised px-4 py-4 text-center">
            <p className="text-xs text-muted">还没有本地任务</p>
            <p className="text-[11px] text-soft">
              从飞书同步 External Task，或手动创建本地 Task
            </p>
            <div className="mt-1 flex gap-2">
              <button
                className="mini-button"
                onClick={() =>
                  setNotice('飞书同步功能将在后续阶段上线，当前为演示模式')
                }
              >
                从飞书同步
              </button>
              <button
                className="mini-button mini-button-primary"
                onClick={() =>
                  setNotice('本地任务创建将在后续阶段上线，当前为演示模式')
                }
              >
                新建本地 Task
              </button>
            </div>
          </div>
        ) : (
          projectLocalTasks.map(renderLocalTask)
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink">
            飞书 External Task 投影
          </h3>
          <button
            className="mini-button mini-button-danger disabled:cursor-not-allowed"
            disabled={selectedForBatch.size < 2}
            onClick={() =>
              requestOperation(
                'batch-delete',
                [...selectedForBatch] as ExternalTaskViewModel['externalTaskId'][]
              )
            }
          >
            批量删除（{selectedForBatch.size}）
          </button>
        </div>
        <p className="text-[11px] text-muted">
          业务字段以飞书为准；派发、执行结果与验收在本地记录。演示模式：不执行真实飞书
          CRUD。
        </p>
        {projectExternalTasks.length === 0 ? (
          <p className="text-xs text-muted">暂无 External Task 投影</p>
        ) : (
          projectExternalTasks.map(renderExternalTask)
        )}
      </div>
    </section>
  )
}
