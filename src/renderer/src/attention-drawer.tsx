import { useEffect, useRef, useState } from 'react'
import type {
  AgentInstanceId,
  AttentionItemId,
  AttentionTarget,
  CommandResult,
  PermissionDecision,
  PermissionRequestId,
  PermissionRequestViewModel,
  ProjectId,
  WorkbenchViewModel
} from './workbench/contract'
import { ATTENTION_KIND_LABEL } from './attention-display'

/**
 * Global Attention Center + Permission Center (#9).
 *
 * A non-modal drawer available from every Project surface and Settings. It
 * aggregates open Attention Items across all Projects and lists pending
 * permission requests with exactly the decisions the authoritative request
 * offers (deny, allow once, allow current Run). Permanent policy is never
 * created here — the drawer only navigates to Settings. Timeout is owned by
 * the adapter: the drawer renders the port-provided deadline as a fact and
 * never infers expiry itself. Everything is a projection of the port
 * snapshot: handling an item dispatches the matching command and the next
 * authoritative snapshot updates the lists.
 */

const DECISION_ACTIONS: Array<{
  decision: PermissionDecision
  label: string
  className: string
}> = [
  {
    decision: 'deny',
    label: '拒绝',
    className:
      'rounded bg-red-950 px-2 py-0.5 text-xs text-red-300 hover:bg-red-900'
  },
  {
    decision: 'allow-once',
    label: '允许一次',
    className:
      'rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700'
  },
  {
    decision: 'allow-current-run',
    label: '允许当前 Run',
    className:
      'rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700'
  }
]

export function AttentionDrawer({
  snapshot,
  onClose,
  onOpenTarget,
  onAnswerPermission,
  onManagePolicy,
  onResolve
}: {
  snapshot: WorkbenchViewModel
  onClose: () => void
  onOpenTarget: (target: AttentionTarget) => void
  onAnswerPermission: (
    request: PermissionRequestViewModel,
    decision: PermissionDecision
  ) => Promise<CommandResult>
  onManagePolicy: (projectId: ProjectId) => void
  onResolve: (attentionItemId: AttentionItemId) => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [answerError, setAnswerError] = useState<{
    requestId: PermissionRequestId
    message: string
  } | null>(null)

  const answerPermission = async (
    request: PermissionRequestViewModel,
    decision: PermissionDecision
  ): Promise<void> => {
    setAnswerError(null)
    const result = await onAnswerPermission(request, decision)
    // Stale rejections already trigger a snapshot refetch upstream; only
    // genuine rejections (e.g. duplicate or unsupported decisions) need an
    // explanation next to the request.
    if (!result.ok && result.reason !== 'stale-revision') {
      setAnswerError({ requestId: request.requestId, message: result.message })
    }
  }

  useEffect(() => {
    // Non-modal drawer: focus moves in on open and returns to the opener
    // (the header trigger) on close, mirroring the confirmation host.
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => {
      if (opener && document.body.contains(opener)) opener.focus()
    }
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const openItems = snapshot.attentionItems.filter(
    (item) => item.state === 'open'
  )
  const agentName = (agentInstanceId: AgentInstanceId): string =>
    snapshot.agents.find((a) => a.agentInstanceId === agentInstanceId)?.name ??
    agentInstanceId
  const projectName = (projectId: ProjectId): string =>
    snapshot.projects.find((p) => p.projectId === projectId)?.name ??
    projectId

  return (
    <aside
      aria-label="Global Attention"
      className="fixed inset-y-0 right-0 z-40 flex w-96 flex-col border-l border-neutral-800 bg-neutral-950"
    >
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <h2 className="text-sm font-medium text-neutral-100">
          Global Attention
        </h2>
        <button
          ref={closeRef}
          className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-700"
          onClick={onClose}
        >
          关闭
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
        <section aria-label="权限请求" className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            权限请求
          </h3>
          {snapshot.permissionRequests.length === 0 ? (
            <p className="text-xs text-neutral-600">暂无待处理的权限请求</p>
          ) : (
            <ul className="space-y-2">
              {snapshot.permissionRequests.map((request) => (
                <li key={request.requestId}>
                  <section
                    aria-label={`权限请求：${agentName(request.agentInstanceId)} ${request.action}`}
                    className="space-y-1.5 rounded bg-neutral-900 px-3 py-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-neutral-100">
                        {agentName(request.agentInstanceId)} · {request.action}
                      </span>
                      <span className="text-[10px] text-neutral-500">
                        {projectName(request.projectId)}
                      </span>
                    </div>
                    <p className="text-xs text-neutral-400">
                      范围：{request.scope}
                    </p>
                    <p className="text-xs text-neutral-400">
                      原因：{request.reason}
                    </p>
                    <p className="text-xs text-neutral-500">
                      默认拒绝截止：
                      {new Date(request.expiresAt).toLocaleString()}
                    </p>
                    <div className="flex gap-1.5 pt-0.5">
                      {DECISION_ACTIONS.filter(({ decision }) =>
                        request.decisions.includes(decision)
                      ).map(({ decision, label, className }) => (
                        <button
                          key={decision}
                          className={className}
                          onClick={() => void answerPermission(request, decision)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {answerError?.requestId === request.requestId && (
                      <p role="alert" className="text-xs text-red-300">
                        {answerError.message}
                      </p>
                    )}
                    <button
                      className="block text-left text-xs text-blue-400 hover:text-blue-300"
                      onClick={() => onManagePolicy(request.projectId)}
                    >
                      在 Settings 中管理永久策略
                    </button>
                  </section>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-neutral-600">
            演示模式：决定仅更新 mock 状态，未连接真实 PermissionBroker。
          </p>
        </section>

        <section aria-label="关注事项" className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            关注事项
          </h3>
          {openItems.length === 0 ? (
            <p className="text-xs text-neutral-600">暂无待处理的关注项</p>
          ) : (
            <ul className="space-y-2">
              {openItems.map((item) => (
                <li
                  key={item.attentionItemId}
                  className="space-y-1 rounded bg-neutral-900 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">
                      {ATTENTION_KIND_LABEL[item.kind]}
                    </span>
                    <span className="text-[10px] text-neutral-500">
                      {projectName(item.target.projectId)}
                    </span>
                  </div>
                  <p className="text-sm text-neutral-200">{item.title}</p>
                  <div className="flex gap-1.5">
                    <button
                      aria-label={`打开：${item.title}`}
                      className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700"
                      onClick={() => onOpenTarget(item.target)}
                    >
                      打开
                    </button>
                    {/* Permission items resolve only through an actual
                        decision — never through a generic mark-done that
                        would bypass the audit and strand the Run. */}
                    {item.kind !== 'permission-requested' && (
                      <button
                        aria-label={`标记已处理：${item.title}`}
                        className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-700"
                        onClick={() => onResolve(item.attentionItemId)}
                      >
                        标记已处理
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  )
}
