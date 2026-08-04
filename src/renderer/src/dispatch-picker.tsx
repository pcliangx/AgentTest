import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  AgentInstanceViewModel,
  DispatchPlan,
  ProjectViewModel,
  TaskRef,
  WorkbenchPort,
  WorkbenchViewModel
} from './workbench/contract'
import type { SendCommand } from './agents-surface'
import { RUNTIME_STATE_LABEL } from './agent-display'
import { useDispatchPlan } from './use-dispatch-plan'
import {
  getProjectDispatchBlockReason,
  isDispatchable
} from './workbench/dispatchability'

/**
 * Unified Dispatch Picker (#6).
 *
 * Lifted to the ProjectShell level so every entry point — Overview, Agents,
 * Tasks and the command surface — opens the SAME picker rather than each
 * surface reinventing a dispatcher. The picker only ever sends a single,
 * well-formed `confirm-dispatch` command; preview/cancel never produce one.
 *
 * @@<agent-name> resolves to visible chips by exact Agent Name match within
 * the active project; `@@all` expands to every instance in the project and
 * requires an explicit second confirmation before broadcasting. Unavailable /
 * archived instances remain visible and block atomic confirmation instead of
 * being silently omitted.
 */

// ---------------------------------------------------------------------------
// @@ parsing
// ---------------------------------------------------------------------------

/**
 * Unquoted `@@name` uses whitespace as its unambiguous boundary. Agent Names
 * containing spaces or colliding with control syntax use exact braced form,
 * e.g. `@@{data review}` or `@@{all}`. Within braces, a backslash escapes the
 * next character, so the unrestricted Agent Name contract remains representable.
 *
 * Bare `@@all` is always broadcast syntax; braced `@@{all}` addresses an Agent
 * literally named `all`. Unknown or malformed mentions remain unresolved and
 * block the whole dispatch rather than risking a partial or wrong target set.
 */
const ALL_TOKEN = 'all'
const WHITESPACE = /\s/u

interface RoutingMention {
  start: number
  end: number
  name: string
  exact: boolean
  validSyntax: boolean
}

interface BroadcastConfirmation {
  projectId: ProjectViewModel['projectId']
  targetIds: AgentInstanceViewModel['agentInstanceId'][]
  instruction: string
  revision: number
  plan: DispatchPlan
}

interface DispatchTargetPreview {
  agentInstanceId: AgentInstanceViewModel['agentInstanceId']
  name: string
  blocked: boolean
  queuePosition: string
}

interface PendingSubmission {
  projectId: ProjectViewModel['projectId']
  targetIds: AgentInstanceViewModel['agentInstanceId'][]
  targetPreviews: DispatchTargetPreview[]
  instruction: string
  resourceScope: string
  revision: number
}

/** Scans routing mentions without consulting project state. */
function scanRoutingMentions(text: string): RoutingMention[] {
  const mentions: RoutingMention[] = []

  for (let index = 0; index < text.length - 1; index++) {
    if (text[index] !== '@' || text[index + 1] !== '@') {
      continue
    }

    const contentStart = index + 2
    if (text[contentStart] === '{') {
      let cursor = contentStart + 1
      let name = ''
      let closed = false
      while (cursor < text.length) {
        const char = text[cursor]
        if (char === '\\' && cursor + 1 < text.length) {
          name += text[cursor + 1]
          cursor += 2
          continue
        }
        if (char === '}') {
          cursor += 1
          closed = true
          break
        }
        name += char
        cursor += 1
      }
      mentions.push({
        start: index,
        end: cursor,
        name,
        exact: true,
        validSyntax: closed && name.length > 0
      })
      index = cursor - 1
      continue
    }

    let cursor = contentStart
    while (cursor < text.length && !WHITESPACE.test(text[cursor])) cursor += 1
    const name = text.slice(contentStart, cursor)
    mentions.push({
      start: index,
      end: cursor,
      name,
      exact: false,
      validSyntax: name.length > 0
    })
    index = cursor - 1
  }

  return mentions
}

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  'textarea:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

const RESOURCE_TYPE_LABEL: Record<
  'task-list' | 'knowledge-space' | 'document' | 'other',
  string
> = {
  'task-list': '任务清单',
  'knowledge-space': '知识空间',
  document: '文档',
  other: '资源'
}

const RESOURCE_OP_LABEL: Record<'read' | 'create' | 'update', string> = {
  read: '读取',
  create: '创建',
  update: '更新'
}

/** Resolves explicit @@ names against every known agent in the project. */
function resolveAtAt(
  text: string,
  agents: AgentInstanceViewModel[]
): {
  ids: Set<AgentInstanceViewModel['agentInstanceId']>
  unresolved: string[]
  hasAll: boolean
  instruction: string
} {
  const ids = new Set<AgentInstanceViewModel['agentInstanceId']>()
  const unresolved: string[] = []
  const byName = new Map<string, AgentInstanceViewModel>()
  for (const a of agents) byName.set(a.name.toLowerCase(), a)

  const consumed: Array<[number, number]> = []
  let hasAll = false
  for (const mention of scanRoutingMentions(text)) {
    if (!mention.validSyntax) {
      unresolved.push(mention.name || '@@')
      continue
    }
    if (!mention.exact && mention.name.toLowerCase() === ALL_TOKEN) {
      hasAll = true
      consumed.push([mention.start, mention.end])
      continue
    }
    const agent = byName.get(mention.name.toLowerCase())
    if (!agent) {
      unresolved.push(mention.name)
      continue
    }
    ids.add(agent.agentInstanceId)
    consumed.push([mention.start, mention.end])
  }

  // Routing mentions are control syntax, not part of the instruction sent to
  // an Agent. Remove every successfully consumed mention while preserving the
  // user's remaining text verbatim apart from outer whitespace.
  const orderedRanges = [...consumed].sort((a, b) => a[0] - b[0])
  let cursor = 0
  let instruction = ''
  for (const [start, end] of orderedRanges) {
    instruction += text.slice(cursor, start)
    cursor = end
  }
  instruction += text.slice(cursor)

  return { ids, unresolved, hasAll, instruction: instruction.trim() }
}

// ---------------------------------------------------------------------------
// Dispatch Picker
// ---------------------------------------------------------------------------

export function DispatchPicker({
  project,
  snapshot,
  planDispatch,
  sendCommand,
  taskContext,
  onClose
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  planDispatch: WorkbenchPort['planDispatch']
  sendCommand: SendCommand
  /**
   * When opened from the Tasks surface (#10), the confirmation sends a
   * task-linked `dispatch-task` instead of a bare `confirm-dispatch`, so
   * every target forms an independent Dispatch/Result on this task.
   */
  taskContext?: { ref: TaskRef; title: string } | null
  onClose: () => void
}) {
  const projectAgents = snapshot.agents.filter(
    (a) => a.projectId === project.projectId
  )
  const projectBlockReason = getProjectDispatchBlockReason(project)
  const projectBlocked = projectBlockReason !== undefined
  // Explicit names resolve against every project Agent. Manual selection is
  // limited to targets that can currently accept a Dispatch.

  const [instruction, setInstruction] = useState('')
  const [manual, setManual] = useState<
    Set<AgentInstanceViewModel['agentInstanceId']>
  >(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const [broadcastConfirmation, setBroadcastConfirmation] =
    useState<BroadcastConfirmation | null>(null)
  const [pendingSubmission, setPendingSubmission] =
    useState<PendingSubmission | null>(null)
  const awaitingBroadcast = broadcastConfirmation !== null
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const pickerDialogRef = useRef<HTMLDivElement>(null)
  const broadcastDialogRef = useRef<HTMLDivElement>(null)
  const broadcastTriggerRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const broadcastWasOpenRef = useRef(false)

  useEffect(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    pickerDialogRef.current?.focus()
    return () => {
      if (openerRef.current?.isConnected) openerRef.current.focus()
    }
  }, [])

  useEffect(() => {
    if (awaitingBroadcast) {
      broadcastWasOpenRef.current = true
      const dialog = broadcastDialogRef.current
      const firstFocusable =
        dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      const focusTarget = firstFocusable ?? dialog
      focusTarget?.focus()
    } else if (broadcastWasOpenRef.current) {
      broadcastWasOpenRef.current = false
      const trigger = broadcastTriggerRef.current
      if (trigger && !trigger.disabled) trigger.focus()
      // Snapshot changes can invalidate the preview and disable its trigger
      // while the nested dialog is closing. Keep focus inside the surviving
      // modal when restoring the trigger is no longer possible.
      if (trigger?.disabled || document.activeElement !== trigger) {
        pickerDialogRef.current?.focus()
      }
    }
  }, [awaitingBroadcast])

  useEffect(() => {
    if (
      broadcastConfirmation &&
      !submitting &&
      broadcastConfirmation.revision !== snapshot.revision
    ) {
      setBroadcastConfirmation(null)
      setNotice('派发预览已变化，请重新确认广播')
    }
  }, [broadcastConfirmation, snapshot.revision, submitting])

  const resolved = resolveAtAt(instruction, projectAgents)
  const targetIds = new Set([...manual, ...resolved.ids])
  if (resolved.hasAll) {
    for (const agent of projectAgents) targetIds.add(agent.agentInstanceId)
  }
  const selectedTargets = projectAgents.filter((a) =>
    targetIds.has(a.agentInstanceId)
  )
  const blockedTargets = selectedTargets.filter((a) => !isDispatchable(a))
  const targets = selectedTargets.filter(isDispatchable)
  const dispatchTargetIds = targets.map((target) => target.agentInstanceId)
  const {
    plan: currentPlan,
    planning,
    error: planError,
    retry: retryPlan
  } = useDispatchPlan({
    planDispatch,
    revision: snapshot.revision,
    projectId: project.projectId,
    targetIds: dispatchTargetIds,
    enabled:
      !projectBlocked &&
      dispatchTargetIds.length > 0 &&
      blockedTargets.length === 0
  })

  const confirmationBlocked =
    projectBlocked ||
    submitting ||
    planning ||
    !currentPlan ||
    targets.length === 0 ||
    blockedTargets.length > 0 ||
    resolved.unresolved.length > 0 ||
    resolved.instruction.length === 0

  const toggleManual = (
    agentInstanceId: AgentInstanceViewModel['agentInstanceId']
  ) => {
    if (submittingRef.current) return
    setManual((prev) => {
      const next = new Set(prev)
      if (next.has(agentInstanceId)) next.delete(agentInstanceId)
      else next.add(agentInstanceId)
      return next
    })
  }

  // Authoritative resource scope comes from the port's Resource Bindings, not
  // from the connection label (#6 P2-3). External Connection and Resource
  // Binding are distinct domain objects (CONTEXT.md); the preview must show
  // what is actually bound (resource type + allowed operations).
  const resourceScope =
    project.resourceBindings.length > 0
      ? project.resourceBindings
          .map(
            (b) =>
              `${b.label}（${RESOURCE_TYPE_LABEL[b.resourceType]}：${b.allowedOperations
                .map((o) => RESOURCE_OP_LABEL[o])
                .join('、')}）`
          )
          .join('；')
      : project.primaryConnectionId
        ? '已连接，但未绑定任何资源'
        : '未绑定连接（仅本地资源）'

  const liveTargetPreviews: DispatchTargetPreview[] = selectedTargets.map(
    (agent) => {
      const blocked = !isDispatchable(agent)
      const entry = currentPlan?.entries.find(
        (candidate) => candidate.agentInstanceId === agent.agentInstanceId
      )
      return {
        agentInstanceId: agent.agentInstanceId,
        name: agent.name,
        blocked,
        queuePosition: blocked
          ? '不可派发'
          : entry?.outcome === 'queue'
            ? `第 ${entry.position} 位`
            : entry?.outcome === 'start'
              ? '无需排队'
              : blockedTargets.length > 0
                ? '待全部目标可派发'
                : planError
                  ? '无法计算'
                  : '计算中…'
      }
    }
  )
  const displayedTargetPreviews =
    pendingSubmission?.targetPreviews ?? liveTargetPreviews
  const displayedTargetIds = pendingSubmission
    ? new Set(pendingSubmission.targetIds)
    : targetIds
  const displayedBlockedTargets = displayedTargetPreviews.filter(
    (target) => target.blocked
  )
  const displayedInstruction =
    pendingSubmission?.instruction ?? resolved.instruction
  const displayedResourceScope =
    pendingSubmission?.resourceScope ?? resourceScope

  const confirm = async () => {
    if (submittingRef.current || confirmationBlocked) {
      return
    }
    setNotice(null)
    if (resolved.hasAll && !broadcastConfirmation) {
      if (!currentPlan) return
      setBroadcastConfirmation({
        projectId: project.projectId,
        targetIds: currentPlan.entries.map(
          (entry) => entry.agentInstanceId
        ),
        instruction: resolved.instruction,
        revision: currentPlan.revision,
        plan: currentPlan
      })
      return
    }
    if (broadcastConfirmation) {
      const currentTargetIds = targets.map((agent) => agent.agentInstanceId)
      const targetSetChanged =
        currentTargetIds.length !== broadcastConfirmation.targetIds.length ||
        currentTargetIds.some(
          (targetId, index) =>
            targetId !== broadcastConfirmation.targetIds[index]
        )
      if (
        !resolved.hasAll ||
        broadcastConfirmation.revision !== snapshot.revision ||
        broadcastConfirmation.projectId !== project.projectId ||
        broadcastConfirmation.instruction !== resolved.instruction ||
        targetSetChanged
      ) {
        setBroadcastConfirmation(null)
        setNotice('派发预览已变化，请重新确认广播')
        return
      }
    }
    const confirmedPlan = broadcastConfirmation?.plan ?? currentPlan
    if (!confirmedPlan || confirmedPlan.revision !== snapshot.revision) return
    // A WorkbenchPort event may arrive before its response. Guard with a ref,
    // not only rendered state, so a second activation in the same pending
    // window cannot mint a fresh CommandId for the same logical confirmation.
    const submission: PendingSubmission = {
      projectId: broadcastConfirmation?.projectId ?? project.projectId,
      targetIds:
        broadcastConfirmation?.targetIds ??
        confirmedPlan.entries.map((entry) => entry.agentInstanceId),
      targetPreviews: targets.map((agent, index) => {
        const entry = confirmedPlan.entries[index]
        return {
          agentInstanceId: agent.agentInstanceId,
          name: agent.name,
          blocked: false,
          queuePosition:
            entry.outcome === 'queue'
              ? `第 ${entry.position} 位`
              : '无需排队'
        }
      }),
      instruction:
        broadcastConfirmation?.instruction ?? resolved.instruction,
      resourceScope,
      revision: confirmedPlan.revision
    }
    submittingRef.current = true
    setPendingSubmission(submission)
    setSubmitting(true)
    try {
      const result = await sendCommand(
        taskContext
          ? {
              kind: 'dispatch-task',
              projectId: submission.projectId,
              taskRef: taskContext.ref,
              targets: submission.targetIds,
              instruction: submission.instruction
            }
          : {
              kind: 'confirm-dispatch',
              projectId: submission.projectId,
              targets: submission.targetIds,
              instruction: submission.instruction
            },
        submission.revision
      )
      if (result.ok) {
        onClose()
      } else {
        setBroadcastConfirmation(null)
        setNotice(result.message)
      }
    } finally {
      submittingRef.current = false
      setPendingSubmission(null)
      setSubmitting(false)
    }
  }

  const cancelPicker = () => {
    if (submittingRef.current) return
    onClose()
  }

  const cancelBroadcast = () => {
    if (submittingRef.current) return
    setBroadcastConfirmation(null)
  }

  // Escape dismisses without dispatching. If the broadcast overlay is open,
  // Escape cancels only that inner step and returns to the picker.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (submittingRef.current) {
        e.preventDefault()
        return
      }
      if (awaitingBroadcast) cancelBroadcast()
      else cancelPicker()
      return
    }
    if (e.key !== 'Tab') return

    const activeDialog = awaitingBroadcast
      ? broadcastDialogRef.current
      : pickerDialogRef.current
    if (!activeDialog) return
    const focusable = Array.from(
      activeDialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    )
    if (focusable.length === 0) {
      e.preventDefault()
      activeDialog.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    const activeAtBoundary =
      active === activeDialog || !activeDialog.contains(active)
    if (e.shiftKey && (active === first || activeAtBoundary)) {
      e.preventDefault()
      last.focus()
    } else if (
      !e.shiftKey &&
      (active === last || activeAtBoundary)
    ) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      ref={pickerDialogRef}
      role="dialog"
      aria-label="派发给 Agent"
      aria-modal="true"
      tabIndex={-1}
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/60"
      onKeyDown={onKeyDown}
    >
      <div
        inert={awaitingBroadcast ? true : undefined}
        className="flex max-h-[80%] w-[40rem] flex-col space-y-3 overflow-auto rounded-lg border border-neutral-700 bg-neutral-900 p-4"
      >
        <h3 className="text-sm font-medium text-neutral-100">派发给 Agent</h3>
        {taskContext && (
          <p className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300">
            任务：{taskContext.title}
          </p>
        )}

        <div className="space-y-1">
          <div className="text-xs text-neutral-400">
            选择目标（当前项目：{project.name}）
          </div>
          <ul
            aria-label="可选 Agent"
            className="max-h-40 space-y-0.5 overflow-auto"
          >
            {projectAgents.map((a) => {
              const disabled =
                projectBlocked || submitting || !isDispatchable(a)
              const selected = displayedTargetIds.has(a.agentInstanceId)
              return (
                <li key={a.agentInstanceId}>
                  <button
                    className={`block w-full rounded px-2 py-1 text-left text-sm ${
                      disabled
                        ? 'cursor-not-allowed text-neutral-600'
                        : selected
                          ? 'bg-neutral-700 text-neutral-100'
                          : 'text-neutral-300 hover:bg-neutral-800'
                    }`}
                    aria-pressed={selected}
                    disabled={disabled}
                    onClick={() => toggleManual(a.agentInstanceId)}
                  >
                    {a.name} · {RUNTIME_STATE_LABEL[a.runtimeState]}
                    {disabled ? '（不可派发）' : ''}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        {projectBlockReason && (
          <p role="alert" className="text-xs text-amber-400">
            {projectBlockReason === 'project-archived'
              ? 'Project 已归档，不能创建新派发。'
              : projectBlockReason === 'project-root-unavailable'
                ? 'Project Root 不可用，不能创建新派发。'
                : 'Project 尚未初始化或绑定 Git 仓库，不能创建新派发。'}
          </p>
        )}

        {displayedTargetPreviews.length > 0 && (
          <div>
            <div className="text-xs text-neutral-400">已选目标</div>
            <ul className="mt-1 flex flex-wrap gap-1">
              {displayedTargetPreviews.map((target) => (
                <li
                  key={target.agentInstanceId}
                  aria-label="已选目标"
                  className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200"
                >
                  {target.name}
                  {target.blocked ? '（不可派发）' : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        {displayedBlockedTargets.length > 0 && (
          <p role="alert" className="text-xs text-amber-400">
            不可派发的目标：
            {displayedBlockedTargets.map((target) => target.name).join('、')}
          </p>
        )}

        {!pendingSubmission && resolved.unresolved.length > 0 && (
          <p role="alert" className="text-xs text-amber-400">
            未识别的名称：{resolved.unresolved.join(', ')}
          </p>
        )}

        {resolved.hasAll && (
          <p className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300">
            @@all 已展开为当前 Project 全部实例（
            {displayedTargetPreviews.length} 个），确认派发前需再次确认广播。
          </p>
        )}

        <label className="block text-xs text-neutral-400">
          指令
          <textarea
            aria-label="指令"
            placeholder="输入指令，可用 @@name、@@{含空格名称} 或 @@all…"
            className="mt-1 min-h-[3rem] w-full resize-none rounded bg-neutral-950 px-2 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600"
            value={instruction}
            disabled={projectBlocked || submitting}
            onChange={(e) => {
              setInstruction(e.target.value)
              setBroadcastConfirmation(null)
            }}
          />
        </label>

        {displayedTargetPreviews.length > 0 &&
          displayedInstruction.length > 0 && (
          <section
            role="region"
            aria-label="派发预览"
            className="space-y-1 rounded border border-neutral-700 bg-neutral-950/60 p-2 text-xs text-neutral-300"
          >
            <div>
              <span className="text-neutral-500">目标：</span>
              {displayedTargetPreviews.map((target) => target.name).join('、')}
            </div>
            <div>
              <span className="text-neutral-500">指令：</span>
              {displayedInstruction}
            </div>
            <div>
              <span className="text-neutral-500">资源范围：</span>
              {displayedResourceScope}
            </div>
            <div
              role="status"
              aria-label="派发计划状态"
              aria-live="polite"
              aria-busy={planning}
            >
              <span className="text-neutral-500">队列位置：</span>
              {displayedTargetPreviews
                .map(
                  (target) => `${target.name}: ${target.queuePosition}`
                )
                .join('，')}
            </div>
          </section>
        )}

        {notice && (
          <p role="alert" className="text-xs text-red-400">
            {notice}
          </p>
        )}

        {planError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 text-xs text-red-400"
          >
            <span>{planError}</span>
            <button
              className="rounded px-2 py-1 text-neutral-300 hover:bg-neutral-800"
              disabled={submitting}
              onClick={retryPlan}
            >
              重新计算
            </button>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-40"
            disabled={submitting}
            onClick={cancelPicker}
          >
            取消
          </button>
          <button
            ref={broadcastTriggerRef}
            className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
            disabled={confirmationBlocked}
            onClick={() => void confirm()}
          >
            {awaitingBroadcast ? '确认广播' : '确认派发'}
          </button>
        </div>

      </div>

      {broadcastConfirmation && (
        <div
          ref={broadcastDialogRef}
          role="dialog"
          aria-label="确认广播派发"
          aria-modal="true"
          tabIndex={-1}
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/70"
        >
          <div className="w-72 space-y-3 rounded-lg border border-neutral-600 bg-neutral-900 p-4">
            <h4 className="text-sm font-medium text-neutral-100">
              确认广播派发
            </h4>
            <p className="text-xs text-neutral-400">
              本次派发将向 {broadcastConfirmation.targetIds.length}{' '}
              个实例发送同一指令，每个目标会生成独立的 Dispatch。是否继续？
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-40"
                disabled={submitting}
                onClick={cancelBroadcast}
              >
                取消
              </button>
              <button
                className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-100 hover:bg-neutral-600"
                disabled={confirmationBlocked}
                onClick={() => void confirm()}
              >
                确认广播
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
