import { useEffect, useRef } from 'react'
import type {
  AgentInstanceId,
  AttentionItemId,
  AttentionTarget,
  PermissionDecision,
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
 * permission requests with their only valid decisions (deny, allow once,
 * allow current Run). Permanent policy is never created here — the drawer
 * only navigates to Settings. Everything is a projection of the port
 * snapshot: handling an item dispatches the matching command and the next
 * authoritative snapshot updates the lists.
 */

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
  ) => void
  onManagePolicy: (projectId: ProjectId) => void
  onResolve: (attentionItemId: AttentionItemId) => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

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
              {snapshot.permissionRequests.map((request) => {
                const expired = Date.now() > request.expiresAt
                return (
                  <li key={request.requestId}>
                    <section
                      aria-label={`权限请求：${agentName(request.agentInstanceId)} ${request.action}`}
                      className="space-y-1.5 rounded bg-neutral-900 px-3 py-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-neutral-100">
                          {agentName(request.agentInstanceId)} ·{' '}
                          {request.action}
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
                      {expired && (
                        <p className="text-xs text-amber-400">
                          已超时，按拒绝处理
                        </p>
                      )}
                      <div className="flex gap-1.5 pt-0.5">
                        <button
                          disabled={expired}
                          className="rounded bg-red-950 px-2 py-0.5 text-xs text-red-300 hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => onAnswerPermission(request, 'deny')}
                        >
                          拒绝
                        </button>
                        <button
                          disabled={expired}
                          className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() =>
                            onAnswerPermission(request, 'allow-once')
                          }
                        >
                          允许一次
                        </button>
                        <button
                          disabled={expired}
                          className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() =>
                            onAnswerPermission(request, 'allow-current-run')
                          }
                        >
                          允许当前 Run
                        </button>
                      </div>
                      <button
                        className="block text-left text-xs text-blue-400 hover:text-blue-300"
                        onClick={() => onManagePolicy(request.projectId)}
                      >
                        在 Settings 中管理永久策略
                      </button>
                    </section>
                  </li>
                )
              })}
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
                    <button
                      aria-label={`标记已处理：${item.title}`}
                      className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-700"
                      onClick={() => onResolve(item.attentionItemId)}
                    >
                      标记已处理
                    </button>
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
