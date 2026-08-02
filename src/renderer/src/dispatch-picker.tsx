import { useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  AgentInstanceViewModel,
  ProjectViewModel,
  WorkbenchViewModel
} from './workbench/contract'
import type { SendCommand } from './agents-surface'
import { RUNTIME_STATE_LABEL } from './agents-surface'
import { isAgentBusy, isDispatchable } from './workbench/dispatchability'

/**
 * Unified Dispatch Picker (#6).
 *
 * Lifted to the ProjectShell level so every entry point — Overview, Agents,
 * Tasks and the command surface — opens the SAME picker rather than each
 * surface reinventing a dispatcher. The picker only ever sends a single,
 * well-formed `confirm-dispatch` command; preview/cancel never produce one.
 *
 * @@<agent-name> resolves to visible chips by exact Agent Name match within
 * the active project; `@@all` expands to all dispatchable instances of the
 * project and requires an explicit second confirmation before broadcasting.
 * Unavailable / archived instances are excluded from dispatch entirely.
 */

// ---------------------------------------------------------------------------
// @@ parsing
// ---------------------------------------------------------------------------

/**
 * `@@<name>` routing must work for any name the create-agent contract allows —
 * including names with spaces (e.g. `data review`) or the reserved-looking
 * prefix `all` (e.g. an agent named `all review`). A naive `@@(\S+)` capture
 * stops at the first space, and a naive `@@all` check shadows longer names.
 *
 * The resolver therefore matches against the project's KNOWN agent names by
 * longest-first: for each known name it scans the text for `@@<name>` and
 * consumes those character ranges. `@@all` is treated as a broadcast only for
 * any `@@` occurrence NOT already claimed by a longer known name. Remaining
 * unclaimed `@@token` runs are reported as unresolved. This keeps creation and
 * routing consistent without tightening name syntax (#6 P1-1).
 */
const AT_AT_TOKEN = /(?:^|\s)@@(\S+)/g
const ALL_TOKEN = 'all'

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

/** Resolves @@ tokens against dispatchable agents of the project. */
function resolveAtAt(
  text: string,
  agents: AgentInstanceViewModel[]
): {
  ids: Set<AgentInstanceViewModel['agentInstanceId']>
  unresolved: string[]
  hasAll: boolean
} {
  const ids = new Set<AgentInstanceViewModel['agentInstanceId']>()
  const unresolved: string[] = []
  const byName = new Map<string, AgentInstanceViewModel>()
  for (const a of agents) byName.set(a.name.toLowerCase(), a)

  // Ranges [start, end) in `text` already consumed by a known-name match, so a
  // shorter name (or `all`) cannot re-claim part of a longer name's mention.
  const consumed: Array<[number, number]> = []
  const overlaps = (start: number, end: number) =>
    consumed.some(([cs, ce]) => start < ce && end > cs)

  // Longest names first so `all review` is matched before `all`.
  const knownNames = [...byName.keys()].sort((a, b) => b.length - a.length)
  for (const name of knownNames) {
    // Match `@@<name>` case-insensitively as a complete mention. The trailing
    // boundary prevents a shorter valid name such as `a` from consuming the
    // prefix of `@@all`, or `cx_review` from claiming `@@cx_review_extra`.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(^|\\s)(@@${escaped})(?=\\s|$)`, 'gi')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      // The `@@` begins right after the captured leading separator.
      const atStart = m.index + m[1].length
      const atEnd = atStart + m[2].length
      if (overlaps(atStart, atEnd)) continue
      consumed.push([atStart, atEnd])
      ids.add(byName.get(name)!.agentInstanceId)
    }
  }

  // Now scan for any remaining `@@token` occurrences not claimed above.
  let hasAll = false
  AT_AT_TOKEN.lastIndex = 0
  let t: RegExpExecArray | null
  while ((t = AT_AT_TOKEN.exec(text)) !== null) {
    const leadLen = t[0].length - t[1].length - 2 // chars before @@
    const atStart = t.index + Math.max(0, leadLen)
    const atEnd = atStart + 2 + t[1].length
    if (overlaps(atStart, atEnd)) continue
    const token = t[1]
    if (token.toLowerCase() === ALL_TOKEN) {
      hasAll = true
    } else {
      unresolved.push(token)
    }
  }

  if (hasAll) {
    for (const a of agents) ids.add(a.agentInstanceId)
  }
  return { ids, unresolved, hasAll }
}

// ---------------------------------------------------------------------------
// Dispatch Picker
// ---------------------------------------------------------------------------

export function DispatchPicker({
  project,
  snapshot,
  sendCommand,
  onClose
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  sendCommand: SendCommand
  onClose: () => void
}) {
  // Only dispatchable instances are selectable. isDispatchable is the single
  // source of truth shared with the adapter, so @@all and manual selection
  // never include a target the port would then reject (#6 P1-1).
  const dispatchable = snapshot.agents.filter(
    (a) => a.projectId === project.projectId && isDispatchable(a)
  )

  const [instruction, setInstruction] = useState('')
  const [manual, setManual] = useState<
    Set<AgentInstanceViewModel['agentInstanceId']>
  >(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const [awaitingBroadcast, setAwaitingBroadcast] = useState(false)
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)

  const resolved = resolveAtAt(instruction, dispatchable)
  const targetIds = new Set([...manual, ...resolved.ids])
  const targets = dispatchable.filter((a) => targetIds.has(a.agentInstanceId))

  const toggleManual = (
    agentInstanceId: AgentInstanceViewModel['agentInstanceId']
  ) => {
    setManual((prev) => {
      const next = new Set(prev)
      if (next.has(agentInstanceId)) next.delete(agentInstanceId)
      else next.add(agentInstanceId)
      return next
    })
  }

  // Authoritative per-target queue position comes from each instance's own
  // queueDepth in the port snapshot — never a renderer-guessed global value.
  const queuePositionFor = (a: AgentInstanceViewModel): string =>
    isAgentBusy(a) ? `第 ${a.queueDepth + 1} 位` : '无需排队'

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

  const confirm = async () => {
    if (
      submittingRef.current ||
      targets.length === 0 ||
      instruction.trim().length === 0
    ) {
      return
    }
    setNotice(null)
    if (resolved.hasAll && !awaitingBroadcast) {
      setAwaitingBroadcast(true)
      return
    }
    // A WorkbenchPort event may arrive before its response. Guard with a ref,
    // not only rendered state, so a second activation in the same pending
    // window cannot mint a fresh CommandId for the same logical confirmation.
    submittingRef.current = true
    setSubmitting(true)
    try {
      const result = await sendCommand({
        kind: 'confirm-dispatch',
        projectId: project.projectId,
        targets: targets.map((a) => a.agentInstanceId),
        instruction: instruction.trim()
      })
      if (result.ok) {
        onClose()
      } else {
        setAwaitingBroadcast(false)
        setNotice(result.message)
      }
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  // Escape dismisses without dispatching. If the broadcast overlay is open,
  // Escape cancels only that inner step and returns to the picker.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    if (awaitingBroadcast) setAwaitingBroadcast(false)
    else onClose()
  }

  return (
    <div
      role="dialog"
      aria-label="派发给 Agent"
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/60"
      onKeyDown={onKeyDown}
    >
      <div className="flex max-h-[80%] w-[40rem] flex-col space-y-3 overflow-auto rounded-lg border border-neutral-700 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-100">派发给 Agent</h3>

        <div className="space-y-1">
          <div className="text-xs text-neutral-400">
            选择目标（当前项目：{project.name}）
          </div>
          <ul
            aria-label="可选 Agent"
            className="max-h-40 space-y-0.5 overflow-auto"
          >
            {snapshot.agents
              .filter((a) => a.projectId === project.projectId)
              .map((a) => {
                const disabled = !isDispatchable(a)
                const selected = targetIds.has(a.agentInstanceId)
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

        {targets.length > 0 && (
          <div>
            <div className="text-xs text-neutral-400">已选目标</div>
            <ul className="mt-1 flex flex-wrap gap-1">
              {targets.map((a) => (
                <li
                  key={a.agentInstanceId}
                  aria-label="已选目标"
                  className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200"
                >
                  {a.name}
                </li>
              ))}
            </ul>
          </div>
        )}

        {resolved.unresolved.length > 0 && (
          <p role="alert" className="text-xs text-amber-400">
            未识别的名称：{resolved.unresolved.join(', ')}
          </p>
        )}

        {resolved.hasAll && (
          <p className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300">
            @@all 已展开为全部可派发实例（{targets.length} 个），确认派发前需再次确认广播。
          </p>
        )}

        <label className="block text-xs text-neutral-400">
          指令
          <textarea
            aria-label="指令"
            placeholder="输入指令，可用 @@<agent-name> 或 @@all…"
            className="mt-1 min-h-[3rem] w-full resize-none rounded bg-neutral-950 px-2 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600"
            value={instruction}
            onChange={(e) => {
              setInstruction(e.target.value)
              setAwaitingBroadcast(false)
            }}
          />
        </label>

        {targets.length > 0 && instruction.trim().length > 0 && (
          <section
            role="region"
            aria-label="派发预览"
            className="space-y-1 rounded border border-neutral-700 bg-neutral-950/60 p-2 text-xs text-neutral-300"
          >
            <div>
              <span className="text-neutral-500">目标：</span>
              {targets.map((a) => a.name).join('、')}
            </div>
            <div>
              <span className="text-neutral-500">指令：</span>
              {instruction.trim()}
            </div>
            <div>
              <span className="text-neutral-500">资源范围：</span>
              {resourceScope}
            </div>
            <div>
              <span className="text-neutral-500">队列位置：</span>
              {targets.map((a) => `${a.name}: ${queuePositionFor(a)}`).join('，')}
            </div>
          </section>
        )}

        {notice && (
          <p role="alert" className="text-xs text-red-400">
            {notice}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
            disabled={
              submitting ||
              targets.length === 0 ||
              instruction.trim().length === 0
            }
            onClick={() => void confirm()}
          >
            {awaitingBroadcast ? '确认广播' : '确认派发'}
          </button>
        </div>

        {awaitingBroadcast && (
          <div
            role="dialog"
            aria-label="确认广播派发"
            className="absolute inset-0 z-40 flex items-center justify-center bg-black/70"
            onKeyDown={onKeyDown}
          >
            <div className="w-72 space-y-3 rounded-lg border border-neutral-600 bg-neutral-900 p-4">
              <h4 className="text-sm font-medium text-neutral-100">
                确认广播派发
              </h4>
              <p className="text-xs text-neutral-400">
                本次派发将向 {targets.length} 个实例发送同一指令，每个目标会生成独立的
                Dispatch。是否继续？
              </p>
              <div className="flex justify-end gap-2">
                <button
                  className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
                  onClick={() => setAwaitingBroadcast(false)}
                >
                  取消
                </button>
                <button
                  className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-100 hover:bg-neutral-600"
                  disabled={submitting}
                  onClick={() => void confirm()}
                >
                  确认广播
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
