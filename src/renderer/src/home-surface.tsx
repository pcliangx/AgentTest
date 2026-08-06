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
  onOpenProject,
  onOpenSettings
}: {
  projects: ProjectViewModel[]
  sendCommand: (body: WorkbenchCommandBody) => Promise<CommandResult>
  /** Enter a Project on its own last surface — the switch bar's path. */
  onOpenProject: (projectId: ProjectId) => void
  /** Jump straight into a Project's Settings surface (#88). */
  onOpenSettings: (projectId: ProjectId) => void
}) {
  return (
    <section role="region" aria-label="首页" className="mx-auto max-w-[860px] space-y-5">
      {/* #88 Hero — gradient brand panel that makes the product promise
          visible at a glance. */}
      <div className="relative overflow-hidden rounded-2xl border border-brand-border bg-gradient-to-br from-brand via-brand to-brand-ink px-6 py-8 text-paper shadow-panel-focus">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-paper/10 blur-2xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-20 -left-10 h-48 w-48 rounded-full bg-paper/10 blur-3xl"
        />
        <div className="relative">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="grid h-9 w-9 place-items-center rounded-xl bg-paper/15 text-xs font-extrabold tracking-[0.08em] backdrop-blur"
            >
              HQ
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-paper/80">
              本地多 Agent 工作台
            </span>
          </div>
          <h2 className="mt-4 text-[26px] font-semibold leading-tight tracking-tight">
            Agent Squad HQ
          </h2>
          <p className="mt-1.5 max-w-[46ch] text-[13px] leading-relaxed text-paper/85">
            在一个工作区内编排 Claude Code、Codex 与 Kimi Code，共享项目上下文、
            互相对接交接。快速建项目，或从最近项目继续。
          </p>
          <div className="mt-4 flex gap-5 text-[11px] text-paper/90">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-paper" aria-hidden="true" />
              {projects.length} 个项目
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-paper" aria-hidden="true" />
              多 Provider 编排
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-paper" aria-hidden="true" />
              本地运行 · 演示模式
            </span>
          </div>
        </div>
      </div>

      <QuickCreateCard sendCommand={sendCommand} />

      {projects.length > 0 && (
        <RecentProjectsCard
          projects={projects}
          onOpenProject={onOpenProject}
          onOpenSettings={onOpenSettings}
        />
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
    <div className="card max-w-[640px]">
      <div className="flex items-center justify-between border-b border-line bg-raised px-4 py-2.5">
        <h3 className="section-label">快速建项目</h3>
        <span className="text-[10px] text-muted">演示模式</span>
      </div>
      <form
        className="space-y-3 px-4 py-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-ink">
            项目名称
            <input
              aria-label="项目名称"
              className="mt-1.5 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink shadow-sm outline-none transition-all placeholder:text-muted focus:border-brand focus:shadow-[0_0_0_3px_var(--color-brand-soft)]"
              placeholder="例如：增长实验平台"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
            />
          </label>
          <label className="block text-xs font-medium text-ink">
            根目录
            <input
              aria-label="根目录"
              className="mt-1.5 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink shadow-sm outline-none transition-all placeholder:text-muted focus:border-brand focus:shadow-[0_0_0_3px_var(--color-brand-soft)]"
              placeholder="~/Projects/my-project"
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-[11px] leading-snug text-muted">
            创建后直接进入该项目；首个 Agent 仍在项目内创建。
          </span>
          <button
            type="submit"
            className="btn btn-primary shrink-0"
            disabled={!name.trim() || !rootPath.trim() || submitting}
          >
            {submitting ? '创建中…' : '创建并进入'}
          </button>
        </div>
      </form>
    </div>
  )
}

/** Deterministic brand-tint palette per project name (decorative only). */
const PROJECT_TINTS = [
  'from-brand to-brand-ink',
  'from-teal to-teal',
  'from-amber to-amber',
  'from-provider-cc to-provider-cc-soft'
] as const

function projectTint(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return PROJECT_TINTS[Math.abs(hash) % PROJECT_TINTS.length]
}

function RecentProjectsCard({
  projects,
  onOpenProject,
  onOpenSettings
}: {
  projects: ProjectViewModel[]
  onOpenProject: (projectId: ProjectId) => void
  onOpenSettings: (projectId: ProjectId) => void
}) {
  // Adapter-owned recency truth (#76): most recently opened first;
  // fixtures without a stamp sort last, keeping the contract's optionality.
  const recent = [...projects].sort(
    (a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)
  )
  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-line bg-raised px-4 py-2.5">
        <h3 className="section-label">最近项目</h3>
        <span className="text-[11px] text-muted">点击直达</span>
      </div>
      <ul aria-label="最近项目" className="divide-y divide-line/70">
        {recent.map((project) => (
          <li key={project.projectId} className="group relative">
            {/* Whole-card open affordance — the name/status area is a
                button so the row is keyboard-accessible without losing the
                separate settings quick action. */}
            <div className="card-hover flex w-full items-center gap-3.5 px-4 py-3">
              <span
                aria-hidden="true"
                className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br text-[15px] font-bold text-paper shadow-sm ${projectTint(project.name)}`}
              >
                {project.name.slice(0, 1)}
              </span>
              <button
                className="min-w-0 flex-1 text-left"
                onClick={() => onOpenProject(project.projectId)}
              >
                <span className="block truncate text-[13px] font-semibold text-ink group-hover:text-brand-ink">
                  {project.name}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted">
                  {project.rootPath ?? '—'}
                  {project.repositoryReadiness === 'ready'
                    ? ' · Git 就绪'
                    : ' · Git 未就绪'}
                </span>
              </button>
              <span className="shrink-0 text-right">
                <time className="block text-[10px] text-muted">
                  {project.lastOpenedAt
                    ? new Date(project.lastOpenedAt).toLocaleString()
                    : '—'}
                </time>
                {project.activeRunCount > 0 && (
                  <span className="mt-0.5 block text-[10px] font-semibold text-brand">
                    {project.activeRunCount} 个 Run 运行中
                  </span>
                )}
              </span>
              <button
                aria-label={`设置 ${project.name}`}
                title="打开项目设置"
                className="mini-button opacity-60 transition-opacity group-hover:opacity-100"
                onClick={() => onOpenSettings(project.projectId)}
              >
                ⚙
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
