import { useState } from 'react'
import type {
  AttentionTarget,
  CommandResult,
  DispatchId,
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
 */

const SYNC_LABEL: Record<TaskSyncState, string> = {
  synced: '已同步',
  offline: '离线',
  conflict: '冲突',
  unavailable: '不可用'
}

const REVIEW_LABEL: Record<ExecutionReviewState, string> = {
  'pending-review': '待评审',
  accepted: '已验收',
  'revision-requested': '已提出修订'
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

  const agentName = (agentInstanceId: string): string =>
    snapshot.agents.find(
      (candidate) => candidate.agentInstanceId === agentInstanceId
    )?.name ?? agentInstanceId

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
      return <p className="text-xs text-neutral-600">暂无派发</p>
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
              className="rounded bg-neutral-950 px-2.5 py-1.5 text-xs"
            >
              <div className="text-neutral-300">
                {agentName(dispatch.agentInstanceId)} · {dispatch.instruction}
              </div>
              {result && (
                <div className="mt-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-neutral-400">{result.summary}</span>
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">
                      {REVIEW_LABEL[result.reviewState]}
                    </span>
                  </div>
                  {result.reviewState === 'pending-review' && (
                    <div className="flex gap-1.5">
                      <button
                        aria-label={`验收：${result.summary.slice(0, 12)}`}
                        className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-neutral-700"
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
                        className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-amber-300 hover:bg-neutral-700"
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
    `space-y-2 rounded border px-3 py-2 ${
      highlighted
        ? 'border-blue-700 bg-neutral-900 ring-1 ring-blue-700'
        : 'border-neutral-800 bg-neutral-900'
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
    return (
      <article
        key={task.externalTaskId}
        data-task-card
        aria-label={`飞书任务：${task.title}`}
        className={cardClass(highlighted)}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label={`选择 ${task.title}`}
              checked={selectedForBatch.has(task.externalTaskId)}
              onChange={() => toggleBatch(task.externalTaskId)}
            />
            <span className="text-sm text-neutral-100">{task.title}</span>
            {highlighted && (
              <span className="rounded bg-blue-950 px-1.5 py-0.5 text-[10px] text-blue-300">
                深链目标
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400">
              {task.externalId} · v{task.version}
            </span>
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
              {SYNC_LABEL[task.syncState]}
            </span>
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
              {BUSINESS_LABEL[task.businessStatus]}
            </span>
          </div>
        </div>

        {task.proposedChange && (
          <p role="alert" className="rounded bg-amber-950/50 px-2 py-1 text-xs text-amber-300">
            拟议修改：{task.proposedChange.summary}（
            {task.proposedChange.failureReason}）
          </p>
        )}

        {renderDispatchResults(taskRef, task.dispatchIds)}

        <div className="flex flex-wrap gap-1.5">
          <button
            className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700"
            onClick={() => onDispatchTask(taskRef, task.title)}
          >
            派发给 Agent
          </button>
          {task.businessStatus === 'open' && (
            <button
              className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-emerald-300 hover:bg-neutral-700"
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
            className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-700"
            onClick={() => requestOperation('change-members', [task.externalTaskId])}
          >
            成员
          </button>
          <button
            className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-700"
            onClick={() =>
              requestOperation('change-permissions', [task.externalTaskId])
            }
          >
            权限
          </button>
          <button
            className="rounded bg-red-950 px-2 py-0.5 text-xs text-red-400 hover:bg-red-900"
            onClick={() => requestOperation('delete', [task.externalTaskId])}
          >
            删除
          </button>
        </div>
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
          <span className="text-sm text-neutral-100">{task.title}</span>
          {highlighted && (
            <span className="rounded bg-blue-950 px-1.5 py-0.5 text-[10px] text-blue-300">
              深链目标
            </span>
          )}
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">
            {LOCAL_STATUS_LABEL[task.status]}
          </span>
        </div>
        {renderDispatchResults(taskRef, task.dispatchIds)}
        <div>
          <button
            className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700"
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
      <h2 className="text-lg font-medium text-neutral-100">任务</h2>
      {notice && (
        <p role="alert" className="rounded bg-red-950/60 px-3 py-1.5 text-xs text-red-300">
          {notice}
        </p>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-neutral-300">
          本地 Project Task
        </h3>
        {projectLocalTasks.length === 0 ? (
          <p className="text-xs text-neutral-600">暂无本地任务</p>
        ) : (
          projectLocalTasks.map(renderLocalTask)
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-neutral-300">
            飞书 External Task 投影
          </h3>
          <button
            className="rounded bg-red-950 px-2 py-0.5 text-xs text-red-400 hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-40"
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
        <p className="text-[11px] text-neutral-600">
          业务字段以飞书为准；派发、执行结果与验收在本地记录。演示模式：不执行真实飞书
          CRUD。
        </p>
        {projectExternalTasks.length === 0 ? (
          <p className="text-xs text-neutral-600">暂无 External Task 投影</p>
        ) : (
          projectExternalTasks.map(renderExternalTask)
        )}
      </div>
    </section>
  )
}
