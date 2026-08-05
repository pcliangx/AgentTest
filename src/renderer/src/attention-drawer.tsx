import { useEffect, useRef, useState } from 'react'
import type {
  ActivityEntry,
  AgentInstanceId,
  AttentionItemId,
  AttentionTarget,
  CommandResult,
  PermissionDecision,
  PermissionRequestId,
  PermissionRequestViewModel,
  ProjectId,
  ProjectViewModel,
  WorkbenchViewModel
} from './workbench/contract'
import { ATTENTION_KIND_LABEL } from './attention-display'
import {
  RUNTIME_STATE_LABEL,
  providerCode,
  providerLabel
} from './agent-display'
import { STATUS_DOT_LABEL, StatusDot, statusDotState } from './status-dot'
import { fieldDescriptor } from './workbench/configuration'

/**
 * Global Attention Center + Permission Center (#9), regrouped as the frozen
 * command-center radar rail (#68): Needs Attention (permission cards first,
 * then attention items), Running & Queued, and 最近完成 agent rows. The
 * header capacity line mirrors the #65 statusbar facts.
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

/** Radar groups cap: the drawer stays a summary; deep links carry the rest. */
const RECENT_COMPLETED_LIMIT = 3

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
  project,
  snapshot,
  onClose,
  onOpenTarget,
  onAnswerPermission,
  onManagePolicy,
  onResolve
}: {
  /** The Project the drawer was opened from — only used for the capacity
   *  line; every list below stays global. */
  project?: ProjectViewModel | null
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
  const agentFor = (agentInstanceId: AgentInstanceId) =>
    snapshot.agents.find((a) => a.agentInstanceId === agentInstanceId)
  const agentName = (agentInstanceId: AgentInstanceId): string =>
    agentFor(agentInstanceId)?.name ?? agentInstanceId
  const projectName = (projectId: ProjectId): string =>
    snapshot.projects.find((p) => p.projectId === projectId)?.name ??
    projectId

  // The policy line of a permission card (#68): the request-owning
  // Project's APPLIED default policy, labelled through the shared
  // catalogue. Never an inferred verdict — Phase 1 records policy as
  // intent, and the card links to Settings for anything permanent.
  const policyLabelFor = (projectId: ProjectId): string => {
    const applied = snapshot.appliedConfigurations.find(
      (c) => c.owner.kind === 'project' && c.owner.projectId === projectId
    )
    const value = applied?.values['permissions.defaultPolicy']
    const option = fieldDescriptor('permissions.defaultPolicy')?.options?.find(
      (o) => o.value === value
    )
    return option?.label ?? String(value ?? '未设置')
  }

  // Radar groups (#68): live rows come straight from the global agent list;
  // 最近完成 replays the latest adapter-recorded run-completed activities.
  const runningOrQueued = snapshot.agents.filter((agent) =>
    ['running', 'queued'].includes(statusDotState(agent.runtimeState))
  )
  const recentCompleted = [...snapshot.activity]
    .filter(
      (entry): entry is ActivityEntry & { agentInstanceId: AgentInstanceId } =>
        entry.kind === 'run-completed' && entry.agentInstanceId !== undefined
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, RECENT_COMPLETED_LIMIT)

  const concurrency = snapshot.global.concurrency

  return (
    <aside
      aria-label="Global Attention"
      className="fixed inset-y-0 right-0 z-40 flex w-96 flex-col border-l border-line bg-paper shadow-overlay"
    >
      <div className="border-b border-line px-3 py-2">
        <div className="flex items-center justify-between gap-2">
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
        {/* Same capacity facts as the #65 shell statusbar, in the frozen
            radar-head order (全局 first). */}
        <p className="mt-1 text-[10px] text-muted">
          全局 {concurrency.activeGlobal} / {concurrency.globalLimit} ·
          Project {project?.activeRunCount ?? 0} / {concurrency.projectLimit}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
        <section aria-label="需要处理" className="space-y-2">
          <h3 className="section-label">
            需要处理
          </h3>
          {policyError && (
            <p role="alert" className="text-xs text-danger">
              {policyError}
            </p>
          )}
          {resolveError && (
            <p role="alert" className="text-xs text-danger">
              {resolveError}
            </p>
          )}
          {snapshot.permissionRequests.length === 0 &&
          openItems.length === 0 ? (
            <p className="text-xs text-muted">暂无待处理事项</p>
          ) : (
            <>
              {snapshot.permissionRequests.length > 0 && (
                <ul className="space-y-2">
                  {snapshot.permissionRequests.map((request) => (
                    <li key={request.requestId}>
                      <section
                        aria-label={`权限请求：${agentName(request.agentInstanceId)} ${request.action}`}
                        className="space-y-1.5 rounded-lg border border-line bg-paper px-3 py-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-ink">
                            {agentName(request.agentInstanceId)} ·{' '}
                            {request.action}
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
                          当前策略：{policyLabelFor(request.projectId)}
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
                              onClick={() =>
                                void answerPermission(request, decision)
                              }
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
              {openItems.length > 0 && (
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
                            onClick={() =>
                              void resolveItem(item.attentionItemId)
                            }
                          >
                            标记已处理
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <p className="text-[11px] text-muted">
            演示模式：决定仅更新 mock 状态，未连接真实 PermissionBroker。
          </p>
        </section>

        <section aria-label="运行中与排队" className="space-y-1">
          <h3 className="section-label">
            运行中与排队
          </h3>
          {runningOrQueued.length === 0 ? (
            <p className="text-xs text-muted">暂无运行中或排队的 Agent</p>
          ) : (
            <ul>
              {runningOrQueued.map((agent) => {
                const dotState = statusDotState(agent.runtimeState)
                const summary = agent.currentTaskSummary
                return (
                  <li key={agent.agentInstanceId}>
                    <RadarRow
                      avatar={providerCode(agent.providerId)}
                      name={agent.name}
                      sublabel={
                        summary ??
                        `${providerLabel(agent.providerId)} · ${
                          RUNTIME_STATE_LABEL[agent.runtimeState]
                        }`
                      }
                      dotState={dotState}
                      // The fallback sublabel already names the runtime
                      // state; labelling the dot there would double-expose
                      // it in the row's accessible name (#65 rule).
                      dotLabel={summary ? STATUS_DOT_LABEL[dotState] : undefined}
                      onOpen={() =>
                        onOpenTarget({
                          kind: 'agent',
                          projectId: agent.projectId,
                          agentInstanceId: agent.agentInstanceId
                        })
                      }
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section aria-label="最近完成" className="space-y-1">
          <h3 className="section-label">
            最近完成
          </h3>
          {recentCompleted.length === 0 ? (
            <p className="text-xs text-muted">暂无最近完成的 Run</p>
          ) : (
            <ul>
              {recentCompleted.map((entry) => {
                const agent = agentFor(entry.agentInstanceId)
                if (!agent) return null
                const dotState = statusDotState(agent.runtimeState)
                return (
                  <li key={entry.activityId}>
                    <RadarRow
                      avatar={providerCode(agent.providerId)}
                      name={agent.name}
                      sublabel={entry.summary}
                      dotState={dotState}
                      // The activity summary never names the runtime state,
                      // so the dot keeps its label (#65 rule).
                      dotLabel={STATUS_DOT_LABEL[dotState]}
                      onOpen={() =>
                        onOpenTarget({
                          kind: 'agent',
                          projectId: agent.projectId,
                          agentInstanceId: agent.agentInstanceId
                        })
                      }
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </aside>
  )
}

/** One frozen radar row (#68): 28px Provider avatar, mono name, muted
 *  sublabel, and the #65 status dot. The dot is labelled only when the
 *  sublabel does not already name the state. Rows are navigation deep
 *  links into the owning Agent, never action buttons. */
function RadarRow({
  avatar,
  name,
  sublabel,
  dotState,
  dotLabel,
  onOpen
}: {
  avatar: string
  name: string
  sublabel: string
  dotState: ReturnType<typeof statusDotState>
  dotLabel?: string
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className="grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-wash"
      onClick={onOpen}
    >
      <span
        aria-hidden="true"
        className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft font-mono text-[9px] font-bold text-brand"
      >
        {avatar}
      </span>
      <span className="min-w-0">
        <strong className="block truncate font-mono text-[10px] font-semibold text-ink">
          {name}
        </strong>
        <small className="block truncate text-[9px] text-muted">
          {sublabel}
        </small>
      </span>
      <StatusDot state={dotState} label={dotLabel} />
    </button>
  )
}
