import { useState } from 'react'
import type {
  CommandResult,
  ProjectId,
  ProjectViewModel,
  WorkbenchCommandBody
} from './workbench/contract'

/**
 * The App-level home page (#76): startup landing page and persistent global
 * work surface — one click away from anywhere via the left navigation's
 * App tier. It owns three jobs: quick project creation (name + root path),
 * direct access to recent projects, and the gateway to the global entries
 * (those live in the left navigation's App tier).
 *
 * Demo boundary (ADR-0011): creation goes through the contract's
 * `create-project` command and the MockScenarioAdapter; the real
 * ProjectStore and native directory picker are Phase 2. All facts come
 * from the WorkbenchPort snapshot; visual language follows the frozen #65
 * tokens and shared classes.
 */
export function HomeSurface({
  projects,
  sendCommand,
  onOpenProject
}: {
  projects: ProjectViewModel[]
  sendCommand: (body: WorkbenchCommandBody) => Promise<CommandResult>
  /** Enter a Project on its own last surface — the switch bar's path. */
  onOpenProject: (projectId: ProjectId) => void
}) {
  return (
    <section role="region" aria-label="首页" className="space-y-4">
      {/* Brand block — the product mark reads the same as the nav rail's. */}
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] bg-brand text-[11px] font-extrabold tracking-[0.06em] text-paper"
        >
          HQ
        </span>
        <div>
          <h2 className="text-lg font-medium text-ink">Agent Squad HQ</h2>
          <p className="text-xs text-muted">
            本地多 Agent 编码工作台：快速建项目，或直达最近项目。
          </p>
        </div>
      </div>

      <QuickCreateCard sendCommand={sendCommand} />

      {projects.length > 0 && (
        <RecentProjectsCard projects={projects} onOpenProject={onOpenProject} />
      )}
    </section>
  )
}

function QuickCreateCard({
  sendCommand
}: {
  sendCommand: (body: WorkbenchCommandBody) => Promise<CommandResult>
}) {
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const result = await sendCommand({ kind: 'create-project', name, rootPath })
      if (!result.ok) {
        setError(result.message)
      }
      // On success the adapter lands inside the new Project — this surface
      // unmounts, so there is nothing local to reset.
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="card max-w-[560px]">
      <div className="border-b border-line bg-raised px-3 py-2">
        <h3 className="section-label">快速建项目</h3>
      </div>
      <form
        className="space-y-2.5 px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label className="block text-xs text-muted">
          项目名称
          <input
            aria-label="项目名称"
            className="mt-1 w-full rounded-lg border border-line bg-paper px-2 py-1.5 text-sm text-ink placeholder:text-muted"
            placeholder="例如：增长实验平台"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
          />
        </label>
        <label className="block text-xs text-muted">
          根目录
          <input
            aria-label="根目录"
            className="mt-1 w-full rounded-lg border border-line bg-paper px-2 py-1.5 text-sm text-ink placeholder:text-muted"
            placeholder="~/Projects/my-project（演示模式：文本输入）"
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <span className="text-[10px] text-muted">
            创建后直接进入该项目；首个 Agent 仍在项目内创建。
          </span>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!name.trim() || submitting}
          >
            创建并进入
          </button>
        </div>
      </form>
    </div>
  )
}

function RecentProjectsCard({
  projects,
  onOpenProject
}: {
  projects: ProjectViewModel[]
  onOpenProject: (projectId: ProjectId) => void
}) {
  // Adapter-owned recency truth (#76): most recently opened first;
  // fixtures without a stamp sort last, keeping the contract's optionality.
  const recent = [...projects].sort(
    (a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)
  )
  return (
    <div className="card max-w-[560px]">
      <div className="border-b border-line bg-raised px-3 py-2">
        <h3 className="section-label">最近项目</h3>
      </div>
      <ul aria-label="最近项目" className="divide-y divide-line">
        {recent.map((project) => (
          <li key={project.projectId}>
            <button
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-wash"
              onClick={() => onOpenProject(project.projectId)}
            >
              <span
                aria-hidden="true"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-soft font-mono text-[10px] font-bold text-brand"
              >
                {project.name.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-ink">
                  {project.name}
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-muted">
                  {project.rootPath ?? '—'}
                </span>
              </span>
              <time className="shrink-0 text-[10px] text-muted">
                {project.lastOpenedAt
                  ? new Date(project.lastOpenedAt).toLocaleString()
                  : '—'}
              </time>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
