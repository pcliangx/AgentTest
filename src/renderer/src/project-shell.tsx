import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActivityEntry,
  CommandResult,
  ProjectId,
  ProjectSurface,
  ProjectViewModel,
  WorkbenchCommand,
  WorkbenchPort,
  WorkbenchViewModel
} from './workbench/contract'
import { id } from './workbench/contract'

// ---------------------------------------------------------------------------
// Hook — the renderer's sole connection to the port
// ---------------------------------------------------------------------------

function useWorkbench(port: WorkbenchPort) {
  const [snapshot, setSnapshot] = useState<WorkbenchViewModel | null>(null)
  const revisionRef = useRef<number>(-1)

  // Shared updater — only accepts snapshots with strictly higher revision.
  // Prevents a stale getSnapshot response from overwriting a newer event.
  const applySnapshot = useCallback((snap: WorkbenchViewModel) => {
    if (snap.revision > revisionRef.current) {
      revisionRef.current = snap.revision
      setSnapshot(snap)
    }
  }, [])

  useEffect(() => {
    let active = true
    // Subscribe FIRST so events arriving during the initial load aren't missed.
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

  const navigate = useCallback(
    (projectId: ProjectId, surface: ProjectSurface): Promise<CommandResult> => {
      const command: WorkbenchCommand = {
        kind: 'navigate',
        commandId: id(crypto.randomUUID(), 'CommandId'),
        expectedRevision: revisionRef.current,
        projectId,
        surface
      }
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

  return { snapshot, navigate }
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

const ROOT_LABEL: Record<string, string> = {
  available: '可用',
  unavailable: '不可用'
}

const GIT_LABEL: Record<string, string> = {
  ready: '已就绪',
  'not-ready': '未就绪'
}

const ACTIVITY_KIND_LABEL: Record<string, string> = {
  'run-started': '运行开始',
  'run-completed': '运行完成',
  'configuration-applied': '配置已应用',
  'permission-decided': '权限已决定'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProjectShell({ port }: { port: WorkbenchPort }) {
  const { snapshot, navigate } = useWorkbench(port)

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

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 text-neutral-500">
        没有可用的 Project
      </div>
    )
  }

  const projectAgents = snapshot.agents.filter(
    (a) => a.projectId === project.projectId
  )
  const connection = snapshot.global.connections.find(
    (c) => c.connectionId === project.primaryConnectionId
  )
  const projectActivity = snapshot.activity
    .filter((a) => a.projectId === project.projectId)
    .sort((a, b) => b.timestamp - a.timestamp)

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 text-sm">
        <span className="font-medium">Agent Squad HQ</span>
        {connection && (
          <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
            {connection.label}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
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
            />
          )}
          {project.currentSurface === 'activity' && (
            <ActivitySurface activity={projectActivity} />
          )}
          {project.currentSurface !== 'overview' &&
            project.currentSurface !== 'activity' && (
              <PlaceholderSurface surface={project.currentSurface} />
            )}
        </main>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

function OverviewSurface({
  project,
  agentCount,
  connectionLabel,
  activity
}: {
  project: ProjectViewModel
  agentCount: number
  connectionLabel?: string
  activity: ActivityEntry[]
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
  const labels: Partial<Record<ProjectSurface, string>> = {
    agents: 'Agent',
    tasks: '任务',
    knowledge: '知识',
    handoffs: '交接',
    settings: '设置'
  }
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-neutral-500">
        {labels[surface]} 工作面尚未实现
      </p>
    </div>
  )
}
