import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActivityEntry,
  ActivityKind,
  AgentProviderId,
  CommandResult,
  ConfirmationId,
  ConnectionId,
  GlobalSurface,
  ProjectId,
  ProjectSurface,
  ProjectViewModel,
  WorkbenchCommand,
  WorkbenchCommandBody,
  WorkbenchPort,
  WorkbenchViewModel
} from './workbench/contract'
import { id } from './workbench/contract'
import { AgentsSurface } from './agents-surface'
import { DispatchPicker } from './dispatch-picker'
import { SettingsSurface } from './settings-surface'

// ---------------------------------------------------------------------------
// Hook — the renderer's sole connection to the port
// ---------------------------------------------------------------------------

function useWorkbench(port: WorkbenchPort) {
  const [snapshot, setSnapshot] = useState<WorkbenchViewModel | null>(null)
  const revisionRef = useRef<number>(-1)

  const applySnapshot = useCallback((snap: WorkbenchViewModel) => {
    if (snap.revision > revisionRef.current) {
      revisionRef.current = snap.revision
      setSnapshot(snap)
    }
  }, [])

  useEffect(() => {
    let active = true
    const unsubscribe = port.subscribe((event) => {
      if (event.kind === 'view-model-updated') {
        applySnapshot(event.snapshot)
      }
    })
    void port.getSnapshot().then((snap) => {
      if (active) applySnapshot(snap)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [port, applySnapshot])

  const sendCommand = useCallback(
    (
      body: WorkbenchCommandBody,
      expectedRevision?: number
    ): Promise<CommandResult> => {
      const command = {
        ...body,
        commandId: id(crypto.randomUUID(), 'CommandId'),
        // Discrete actions default to the latest known revision; gestures
        // based on an older render pass their baseline explicitly, so the
        // port can reject them as stale instead of letting them overwrite
        // state that arrived after the gesture started.
        expectedRevision: expectedRevision ?? revisionRef.current
      } as WorkbenchCommand
      const result = port.dispatch(command)
      void result.then((r) => {
        if (!r.ok && r.reason === 'stale-revision') {
          void port.getSnapshot().then(applySnapshot)
        }
      })
      return result
    },
    [port, applySnapshot]
  )

  const planDispatch = useCallback<WorkbenchPort['planDispatch']>(
    (request) => {
      const result = port.planDispatch(request)
      void result.then(
        (planned) => {
          if (!planned.ok && planned.reason === 'stale-revision') {
            void port.getSnapshot().then(applySnapshot, () => {})
          }
        },
        () => {}
      )
      return result
    },
    [port, applySnapshot]
  )

  const navigate = useCallback(
    (projectId: ProjectId, surface: ProjectSurface): Promise<CommandResult> =>
      sendCommand({ kind: 'navigate', projectId, surface }),
    [sendCommand]
  )

  const navigateGlobal = useCallback(
    (surface: GlobalSurface) =>
      sendCommand({ kind: 'navigate-global', surface }),
    [sendCommand]
  )

  const requestConnectionDeletion = useCallback(
    (connectionId: ConnectionId) => {
      setConfirmationError(null)
      confirmAttemptRef.current++ // invalidate any in-flight confirm
      return sendCommand({ kind: 'request-connection-deletion', connectionId })
    },
    [sendCommand]
  )

  const requestProviderRecovery = useCallback(
    (providerId: AgentProviderId) =>
      sendCommand({ kind: 'request-provider-recovery', providerId }),
    [sendCommand]
  )

  const [confirmationError, setConfirmationError] = useState<{
    id: ConfirmationId
    message: string
  } | null>(null)
  const confirmAttemptRef = useRef(0)

  const confirmDangerousAction = useCallback(
    (confirmationId: ConfirmationId) => {
      confirmAttemptRef.current++
      const attempt = confirmAttemptRef.current
      const result = sendCommand({
        kind: 'confirm-dangerous-action',
        confirmationId
      })
      void result.then((r) => {
        if (attempt !== confirmAttemptRef.current) return // stale attempt
        if (!r.ok && r.reason !== 'stale-revision') {
          setConfirmationError({ id: confirmationId, message: r.message })
        }
      })
      return result
    },
    [sendCommand]
  )

  const dismissConfirmation = useCallback(() => {
    setConfirmationError(null)
    confirmAttemptRef.current++ // invalidate any in-flight confirm
    return sendCommand({ kind: 'dismiss-confirmation' })
  }, [sendCommand])

  return {
    snapshot,
    navigate,
    planDispatch,
    sendCommand,
    navigateGlobal,
    requestConnectionDeletion,
    requestProviderRecovery,
    confirmDangerousAction,
    dismissConfirmation,
    confirmationError
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SURFACES: Array<{ surface: ProjectSurface; label: string }> = [
  { surface: 'overview', label: '概览' },
  { surface: 'agents', label: 'Agent' },
  { surface: 'tasks', label: '任务' },
  { surface: 'knowledge', label: '知识' },
  { surface: 'handoffs', label: '交接' },
  { surface: 'activity', label: '活动' },
  { surface: 'settings', label: '设置' }
]

const GLOBAL_ENTRIES: Array<{ surface: GlobalSurface; label: string }> = [
  { surface: 'connections', label: '连接' },
  { surface: 'provider-health', label: 'Provider 健康' },
  { surface: 'global-settings', label: '全局设置' }
]

const ROOT_LABEL: Record<string, string> = {
  available: '可用',
  unavailable: '不可用'
}

const GIT_LABEL: Record<string, string> = {
  ready: '已就绪',
  'not-ready': '未就绪'
}

const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  'run-started': '运行开始',
  'run-completed': '运行完成',
  'run-failed': '运行失败',
  'run-interrupted': '运行已中断',
  'run-cancelled': '运行已取消',
  'configuration-applied': '配置已应用',
  'permission-decided': '权限已决定',
  'instruction-sent': '指令已发送',
  'dispatch-created': '派发已创建',
  'queue-cancelled': '排队已取消',
  'dangerous-action-confirmed': '高风险操作已确认'
}

const CONNECTION_STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  disconnected: '未连接',
  offline: '离线',
  error: '错误'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProjectShell({ port }: { port: WorkbenchPort }) {
  const {
    snapshot,
    navigate,
    planDispatch,
    sendCommand,
    navigateGlobal,
    requestConnectionDeletion,
    requestProviderRecovery,
    confirmDangerousAction,
    dismissConfirmation,
    confirmationError
  } = useWorkbench(port)
  // The unified Dispatch Picker lives at shell level so all Project surfaces
  // open the same dispatcher instead of owning divergent implementations.
  const [showPicker, setShowPicker] = useState(false)

  if (!snapshot) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 text-neutral-500">
        加载中…
      </div>
    )
  }

  const project =
    snapshot.projects.find((p) => p.projectId === snapshot.activeProjectId) ??
    snapshot.projects[0]

  const inGlobalView = snapshot.activeGlobalSurface !== undefined

  const projectAgents = project
    ? snapshot.agents.filter((a) => a.projectId === project.projectId)
    : []
  const connection = project
    ? snapshot.global.connections.find(
        (c) => c.connectionId === project.primaryConnectionId
      )
    : undefined
  const projectActivity = project
    ? snapshot.activity
        .filter((a) => a.projectId === project.projectId)
        .sort((a, b) => b.timestamp - a.timestamp)
    : []

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <header
        inert={showPicker ? true : undefined}
        className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 text-sm"
      >
        <div className="flex items-center gap-3">
          <span className="font-medium">Agent Squad HQ</span>
          <div className="flex items-center gap-1">
            {GLOBAL_ENTRIES.map(({ surface, label }) => {
              const isActive =
                inGlobalView && snapshot.activeGlobalSurface === surface
              return (
                <button
                  key={surface}
                  aria-current={isActive ? 'page' : undefined}
                  className={`rounded px-2 py-0.5 text-xs transition-colors ${
                    isActive
                      ? 'bg-neutral-700 text-neutral-100'
                      : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
                  }`}
                  onClick={() => void navigateGlobal(surface)}
                >
                  {label}
                </button>
              )
            })}
          </div>
          {inGlobalView && project && (
            <button
              className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-700"
              onClick={() =>
                void navigate(project.projectId, project.currentSurface)
              }
            >
              ← 返回项目
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {project && (
            <button
              className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700"
              onClick={() => setShowPicker(true)}
            >
              派发给 Agent
            </button>
          )}
          {!inGlobalView && connection && (
            <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
              {connection.label}
            </span>
          )}
        </div>
      </header>

      {inGlobalView ? (
        <main
          inert={showPicker ? true : undefined}
          className="min-h-0 flex-1 overflow-auto p-4"
        >
          {snapshot.activeGlobalSurface === 'connections' && (
            <ConnectionsSurface
              connections={snapshot.global.connections}
              onDelete={(connectionId) =>
                void requestConnectionDeletion(connectionId)
              }
            />
          )}
          {snapshot.activeGlobalSurface === 'provider-health' && (
            <ProviderHealthSurface
              providers={snapshot.global.providers}
              onRecovery={(providerId) =>
                void requestProviderRecovery(providerId)
              }
            />
          )}
          {snapshot.activeGlobalSurface === 'global-settings' && (
            <GlobalSettingsSurface />
          )}
        </main>
      ) : project ? (
        <div
          inert={showPicker ? true : undefined}
          className="flex min-h-0 flex-1"
        >
          <nav
            className="w-48 shrink-0 border-r border-neutral-800 p-2"
            aria-label="主导航"
          >
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-wide text-neutral-600">
                当前项目
              </div>
              <select
                aria-label="切换项目"
                className="mt-0.5 w-full rounded bg-neutral-900 px-1.5 py-1 text-sm text-neutral-200 outline-none"
                value={project.projectId}
                onChange={(e) => {
                  const targetId = id(e.target.value, 'ProjectId')
                  const target = snapshot.projects.find(
                    (p) => p.projectId === targetId
                  )
                  void navigate(targetId, target?.currentSurface ?? 'overview')
                }}
              >
                {snapshot.projects.map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-0.5">
              {SURFACES.map(({ surface, label }) => (
                <button
                  key={surface}
                  className={`block w-full rounded px-2 py-1 text-left text-sm transition-colors ${
                    project.currentSurface === surface
                      ? 'bg-neutral-800 text-neutral-100'
                      : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
                  }`}
                  onClick={() => void navigate(project.projectId, surface)}
                >
                  {label}
                </button>
              ))}
            </div>
          </nav>

          <main className="min-h-0 flex-1 overflow-auto p-4">
            {project.currentSurface === 'overview' && (
              <OverviewSurface
                project={project}
                agentCount={projectAgents.length}
                connectionLabel={connection?.label}
                activity={projectActivity.slice(0, 5)}
                onDispatch={() => setShowPicker(true)}
              />
            )}
            {project.currentSurface === 'activity' && (
              <ActivitySurface activity={projectActivity} />
            )}
            {project.currentSurface === 'agents' && (
              <AgentsSurface
                key={project.projectId}
                project={project}
                snapshot={snapshot}
                planDispatch={planDispatch}
                sendCommand={sendCommand}
                onDispatch={() => setShowPicker(true)}
              />
            )}
            {project.currentSurface === 'settings' && (
              <SettingsSurface
                key={project.projectId}
                project={project}
                snapshot={snapshot}
                sendCommand={sendCommand}
              />
            )}
            {project.currentSurface !== 'overview' &&
              project.currentSurface !== 'activity' &&
              project.currentSurface !== 'agents' &&
              project.currentSurface !== 'settings' && (
                <PlaceholderSurface surface={project.currentSurface} />
              )}
          </main>
        </div>
      ) : (
        <div
          inert={showPicker ? true : undefined}
          className="flex min-h-0 flex-1 items-center justify-center bg-neutral-950 text-neutral-500"
        >
          没有可用的 Project
        </div>
      )}

      {showPicker && project && (
        <DispatchPicker
          project={project}
          snapshot={snapshot}
          planDispatch={planDispatch}
          sendCommand={sendCommand}
          onClose={() => setShowPicker(false)}
        />
      )}

      {snapshot.pendingConfirmation && (
        <ConfirmationModal
          confirmation={snapshot.pendingConfirmation}
          error={
            confirmationError?.id ===
            snapshot.pendingConfirmation!.confirmationId
              ? confirmationError.message
              : null
          }
          onConfirm={() =>
            void confirmDangerousAction(
              snapshot.pendingConfirmation!.confirmationId
            )
          }
          onCancel={() => void dismissConfirmation()}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Project surfaces
// ---------------------------------------------------------------------------

function OverviewSurface({
  project,
  agentCount,
  connectionLabel,
  activity,
  onDispatch
}: {
  project: ProjectViewModel
  agentCount: number
  connectionLabel?: string
  activity: ActivityEntry[]
  onDispatch: () => void
}) {
  return (
    <section role="region" aria-label="项目概览" className="space-y-4">
      <h2 className="text-lg font-medium text-neutral-100">{project.name}</h2>

      <div className="flex gap-6 text-sm">
        <div>
          <span className="text-neutral-500">根目录</span>
          <span className="ml-1.5 text-neutral-200">
            {ROOT_LABEL[project.rootAvailability]}
          </span>
        </div>
        <div>
          <span className="text-neutral-500">Git</span>
          <span className="ml-1.5 text-neutral-200">
            {GIT_LABEL[project.repositoryReadiness]}
          </span>
        </div>
      </div>

      <div className="text-sm">
        <span className="text-neutral-500">连接</span>
        <span className="ml-1.5 text-neutral-200">
          {connectionLabel ?? '未连接'}
        </span>
      </div>

      <div className="flex gap-3">
        <StatCard value={agentCount} label="Agent" />
        <StatCard value={project.activeRunCount} label="活动运行" />
        <StatCard value={project.queuedRunCount} label="排队" />
        <StatCard value={project.attentionCount} label="关注" />
      </div>

      <div className="flex gap-2">
        <button
          className="rounded bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700"
          onClick={onDispatch}
        >
          派发给 Agent
        </button>
      </div>

      <div>
        <h3 className="mb-2 text-sm text-neutral-400">最近活动</h3>
        <ul className="space-y-1">
          {activity.map((entry) => (
            <li key={entry.activityId} className="text-xs text-neutral-400">
              {entry.summary}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function StatCard({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded bg-neutral-900 px-3 py-2">
      <span className="text-xl text-neutral-100">{value}</span>
      <span className="ml-1 text-xs text-neutral-500">{label}</span>
    </div>
  )
}

function ActivitySurface({ activity }: { activity: ActivityEntry[] }) {
  return (
    <section role="region" aria-label="活动" className="space-y-2">
      <h2 className="mb-3 text-lg text-neutral-200">活动</h2>
      {activity.length === 0 ? (
        <p className="text-sm text-neutral-500">暂无活动记录</p>
      ) : (
        <ul className="space-y-2">
          {activity.map((entry) => (
            <li
              key={entry.activityId}
              className="border-b border-neutral-800 pb-2 text-sm"
            >
              <div className="text-neutral-300">{entry.summary}</div>
              <div className="mt-0.5 text-xs text-neutral-600">
                {ACTIVITY_KIND_LABEL[entry.kind] ?? entry.kind}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function PlaceholderSurface({ surface }: { surface: ProjectSurface }) {
  const label = SURFACES.find((s) => s.surface === surface)?.label ?? surface
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-neutral-500">
        {label} 工作面尚未实现
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Global surfaces
// ---------------------------------------------------------------------------

function ConnectionsSurface({
  connections,
  onDelete
}: {
  connections: WorkbenchViewModel['global']['connections']
  onDelete: (connectionId: ConnectionId) => void
}) {
  return (
    <section role="region" aria-label="全局连接" tabIndex={-1} className="space-y-3">
      <h2 className="text-lg font-medium text-neutral-100">连接</h2>
      {connections.length === 0 ? (
        <p className="text-sm text-neutral-500">暂无连接</p>
      ) : (
        <ul className="space-y-2">
          {connections.map((conn) => (
            <li
              key={conn.connectionId}
              className="flex items-center justify-between rounded bg-neutral-900 px-3 py-2"
            >
              <div className="flex items-center gap-3">
                <span className="text-sm text-neutral-200">{conn.label}</span>
                <span className="text-xs text-neutral-500">
                  {CONNECTION_STATUS_LABEL[conn.status] ?? conn.status}
                </span>
              </div>
              <button
                className="rounded bg-red-950 px-2 py-0.5 text-xs text-red-400 hover:bg-red-900"
                onClick={() => onDelete(conn.connectionId)}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ProviderHealthSurface({
  providers,
  onRecovery
}: {
  providers: WorkbenchViewModel['global']['providers']
  onRecovery: (providerId: AgentProviderId) => void
}) {
  return (
    <section role="region" aria-label="Provider 健康" className="space-y-3">
      <h2 className="text-lg font-medium text-neutral-100">Provider 健康</h2>
      <ul className="space-y-2">
        {providers.map((p) => (
          <li
            key={p.providerId}
            className="flex items-center justify-between rounded bg-neutral-900 px-3 py-2"
          >
            <span className="text-sm text-neutral-200">{p.displayName}</span>
            <div className="flex items-center gap-2">
              <span
                className={`text-xs ${
                  p.status === 'ready' ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {p.status === 'ready' ? '可用' : '已阻断'}
              </span>
              {p.status === 'blocked' && (
                <button
                  className="text-xs text-blue-400 hover:text-blue-300"
                  onClick={() => onRecovery(p.providerId)}
                >
                  恢复
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function GlobalSettingsSurface() {
  return (
    <section role="region" aria-label="全局设置" className="space-y-3">
      <h2 className="text-lg font-medium text-neutral-100">全局设置</h2>
      <p className="text-sm text-neutral-500">全局设置工作面尚未实现</p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Confirmation modal — reusable high-risk action host
// ---------------------------------------------------------------------------

function ConfirmationModal({
  confirmation,
  error,
  onConfirm,
  onCancel
}: {
  confirmation: WorkbenchViewModel['pendingConfirmation']
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Save the currently focused element to restore when the modal closes.
    const opener = document.activeElement as HTMLElement | null
    confirmRef.current?.focus()
    return () => {
      if (opener && document.body.contains(opener)) {
        opener.focus()
      } else {
        // Opener was removed (e.g., connection row deleted) — fall back to
        // the first remaining button in the content area; if none remain
        // (all connections deleted), focus the section heading.
        const mainEl = document.querySelector('main')
        const btn = mainEl?.querySelector<HTMLButtonElement>(
          'button:not([disabled])'
        )
        if (btn) {
          btn.focus()
        } else {
          const section = mainEl?.querySelector('[aria-label="全局连接"]')
          if (section instanceof HTMLElement) section.focus()
        }
      }
    }
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={confirmation!.action}
        className="w-full max-w-md space-y-3 rounded-lg bg-neutral-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-medium text-neutral-100">
          {confirmation!.action}
        </h3>
        <dl className="space-y-1.5 text-sm">
          <div>
            <dt className="inline text-neutral-500">目标：</dt>
            <dd className="inline text-neutral-200">{confirmation!.target}</dd>
          </div>
          <div>
            <dt className="inline text-neutral-500">影响：</dt>
            <dd className="inline text-neutral-200">{confirmation!.impact}</dd>
          </div>
          <div>
            <dt className="inline text-neutral-500">不可跳过：</dt>
            <dd className="inline text-neutral-200">
              {confirmation!.nonBypassableReason}
            </dd>
          </div>
        </dl>
        {error && (
          <div className="rounded bg-red-950/60 px-3 py-1.5 text-xs text-red-300">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            ref={confirmRef}
            className="rounded bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-600"
            onClick={onConfirm}
          >
            确认
          </button>
        </div>
      </div>
    </div>
  )
}
