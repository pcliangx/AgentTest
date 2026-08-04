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
    className: 'mini-button mini-button-danger'
  },
  {
    decision: 'allow-once',
    label: '允许一次',
    className: 'mini-button'
  },
  {
    decision: 'allow-current-run',
    label: '允许当前 Run',
    className: 'mini-button'
  }
]

/**
 * A rejected command always deserves a visible, recoverable explanation
 * (spec 632–633). A stale-revision means the action did NOT happen; the
 * upstream refetch already brought the latest state, so the hint asks the
 * user to retry instead of pretending the click worked.
 */
function rejectionMessage(result: Extract<CommandResult, { ok: false }>): string {
  return result.reason === 'stale-revision'
    ? '操作基于过期状态，已刷新最新状态，请重试'
    : result.message
}

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
  onManagePolicy: (projectId: ProjectId) => Promise<CommandResult>
  onResolve: (attentionItemId: AttentionItemId) => Promise<CommandResult>
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [answerError, setAnswerError] = useState<{
    requestId: PermissionRequestId
    message: string
  } | null>(null)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [policyError, setPolicyError] = useState<string | null>(null)

  const answerPermission = async (
    request: PermissionRequestViewModel,
    decision: PermissionDecision
  ): Promise<void> => {
    setAnswerError(null)
    const result = await onAnswerPermission(request, decision)
    if (!result.ok) {
      setAnswerError({
        requestId: request.requestId,
        message: rejectionMessage(result)
      })
    }
  }

  const resolveItem = async (
    attentionItemId: AttentionItemId
  ): Promise<void> => {
    setResolveError(null)
    const result = await onResolve(attentionItemId)
    // A rejected resolve must not look resolved: keep the item and show a
    // retryable explanation (spec 632–633).
    if (!result.ok) {
      setResolveError(rejectionMessage(result))
    }
  }

  const managePolicy = async (projectId: ProjectId): Promise<void> => {
    setPolicyError(null)
    const result = await onManagePolicy(projectId)
    // The shell commits its local close/remount only on success; here we
    // just surface the failure without losing the request context.
    if (!result.ok) {
      setPolicyError(rejectionMessage(result))
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
      className="fixed inset-y-0 right-0 z-40 flex w-96 flex-col border-l border-line bg-paper shadow-overlay"
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="text-sm font-medium text-ink">
          Global Attention
        </h2>
        <button
          ref={closeRef}
          className="mini-button"
          onClick={onClose}
        >
          关闭
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
        <section aria-label="权限请求" className="space-y-2">
          <h3 className="section-label">
            权限请求
          </h3>
          {policyError && (
            <p role="alert" className="text-xs text-danger">
              {policyError}
            </p>
          )}
          {snapshot.permissionRequests.length === 0 ? (
            <p className="text-xs text-muted">暂无待处理的权限请求</p>
          ) : (
            <ul className="space-y-2">
              {snapshot.permissionRequests.map((request) => (
                <li key={request.requestId}>
                  <section
                    aria-label={`权限请求：${agentName(request.agentInstanceId)} ${request.action}`}
                    className="space-y-1.5 rounded-lg border border-line bg-paper px-3 py-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-ink">
                        {agentName(request.agentInstanceId)} · {request.action}
                      </span>
                      <span className="text-[10px] text-muted">
                        {projectName(request.projectId)}
                      </span>
                    </div>
                    <p className="text-xs text-muted">
                      范围：{request.scope}
                    </p>
                    <p className="text-xs text-muted">
                      原因：{request.reason}
                    </p>
                    <p className="text-xs text-muted">
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
                      <p role="alert" className="text-xs text-danger">
                        {answerError.message}
                      </p>
                    )}
                    <button
                      className="block text-left text-xs text-brand hover:underline"
                      onClick={() => void managePolicy(request.projectId)}
                    >
                      在 Settings 中管理永久策略
                    </button>
                  </section>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted">
            演示模式：决定仅更新 mock 状态，未连接真实 PermissionBroker。
          </p>
        </section>

        <section aria-label="关注事项" className="space-y-2">
          <h3 className="section-label">
            关注事项
          </h3>
          {resolveError && (
            <p role="alert" className="text-xs text-danger">
              {resolveError}
            </p>
          )}
          {openItems.length === 0 ? (
            <p className="text-xs text-muted">暂无待处理的关注项</p>
          ) : (
            <ul className="space-y-2">
              {openItems.map((item) => (
                <li
                  key={item.attentionItemId}
                  className="space-y-1 rounded-lg border border-line bg-paper px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="chip">
                      {ATTENTION_KIND_LABEL[item.kind]}
                    </span>
                    <span className="text-[10px] text-muted">
                      {projectName(item.target.projectId)}
                    </span>
                  </div>
                  <p className="text-sm text-ink">{item.title}</p>
                  <div className="flex gap-1.5">
                    <button
                      aria-label={`打开：${item.title}`}
                      className="mini-button"
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
                        className="mini-button"
                        onClick={() => void resolveItem(item.attentionItemId)}
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
