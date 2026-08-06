import type {
  GlobalSurface,
  ProjectSurface,
  ProjectViewModel
} from './workbench/contract'

/**
 * #92 spec 2: the unified ~220px sidebar — merges the former 82px dark icon
 * rail (#65/#76) and the 244px context pane (#66) into one column. The mental
 * model drops from "rail + pane + workspace" to "sidebar + workspace".
 *
 * Sections (top→bottom):
 * 1. Brand mark (small)
 * 2. App-level nav (首页 / 连接 / Provider 健康 / 全局设置)
 * 3. ── divider ──
 * 4. Project-level nav (概览 / Agent / 任务 / 知识 / 交接 / 活动 / 设置)
 * 5. ── divider ──
 * 6. children — the Agent Directory content (only rendered in project view
 *    by the shell)
 * 7. Attention button (bottom-pinned)
 *
 * Light `bg-raised` surface; nav items are icon+text horizontal rows (32px)
 * instead of the old stacked icon-only rail. ARIA preserved: `navigation`
 * "主导航", `group` "App 级", `group` "项目工作面".
 */

const SURFACES: Array<{ surface: ProjectSurface; label: string }> = [
  { surface: 'overview', label: '概览' },
  { surface: 'agents', label: 'Agent' },
  { surface: 'tasks', label: '任务' },
  { surface: 'knowledge', label: '知识' },
  { surface: 'handoffs', label: '交接' },
  { surface: 'activity', label: '活动' },
  { surface: 'settings', label: '设置' }
]

const NAV_ITEMS: Array<{ surface: ProjectSurface; glyph: string }> = [
  { surface: 'overview', glyph: '⌂' },
  { surface: 'agents', glyph: '⌘' },
  { surface: 'tasks', glyph: '✓' },
  { surface: 'knowledge', glyph: '◇' },
  { surface: 'handoffs', glyph: '⇄' },
  { surface: 'activity', glyph: '≋' },
  { surface: 'settings', glyph: '⚙' }
]

const APP_NAV_ITEMS: Array<{ surface: GlobalSurface; label: string; glyph: string }> = [
  { surface: 'home', label: '首页', glyph: '⌂' },
  { surface: 'connections', label: '连接', glyph: '🔗' },
  { surface: 'provider-health', label: 'Provider 健康', glyph: '📡' },
  { surface: 'global-settings', label: '全局设置', glyph: '⚙' }
]

/** Light-theme sidebar nav item: horizontal icon+text, 32px min-height. */
const sidebarItemClass = (isActive: boolean): string =>
  `flex min-h-[32px] w-full shrink-0 items-center gap-2 rounded-lg px-2.5 text-[12px] transition-colors ${
    isActive
      ? 'bg-brand-soft font-semibold text-brand'
      : 'text-ink-secondary hover:bg-wash hover:text-ink'
  }`

export function Sidebar({
  inGlobalView,
  activeGlobalSurface,
  project,
  onNavigateGlobal,
  onNavigateSurface,
  showAttention,
  attentionCount,
  onOpenAttention,
  children
}: {
  inGlobalView: boolean
  activeGlobalSurface: GlobalSurface | undefined
  project: ProjectViewModel | undefined
  onNavigateGlobal: (surface: GlobalSurface) => void
  onNavigateSurface: (surface: ProjectSurface) => void
  showAttention: boolean
  attentionCount: number
  onOpenAttention: () => void
  /** Agent Directory content (ContextPane), rendered in project view. */
  children?: React.ReactNode
}) {
  return (
    <aside className="flex w-[220px] shrink-0 flex-col border-r border-line bg-raised">
      {/* Brand mark */}
      <div
        aria-hidden="true"
        className="flex h-[40px] shrink-0 items-center gap-2 px-3"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand text-[10px] font-extrabold tracking-[0.06em] text-paper">
          HQ
        </span>
        <span className="text-[12px] font-semibold text-ink">
          Agent Squad HQ
        </span>
      </div>

      {/* Navigation — always visible */}
      <nav
        aria-label="主导航"
        className="flex shrink-0 flex-col gap-1 px-2"
      >
        <div
          role="group"
          aria-label="App 级"
          className="flex flex-col gap-0.5"
        >
          {APP_NAV_ITEMS.map(({ surface, label, glyph }) => {
            const isActive =
              inGlobalView && activeGlobalSurface === surface
            return (
              <button
                key={surface}
                aria-current={isActive ? 'page' : undefined}
                className={sidebarItemClass(isActive)}
                onClick={() => onNavigateGlobal(surface)}
              >
                <span
                  aria-hidden="true"
                  className="grid h-4 w-4 shrink-0 place-items-center text-[14px] font-bold"
                >
                  {glyph}
                </span>
                <span>{label}</span>
              </button>
            )
          })}
        </div>

        <div
          aria-hidden="true"
          className="mx-1 my-0.5 h-px bg-line"
        />

        <div
          role="group"
          aria-label="项目工作面"
          className="flex flex-col gap-0.5"
        >
          {NAV_ITEMS.map(({ surface, glyph }) => {
            const isActive =
              !inGlobalView && project?.currentSurface === surface
            const label =
              SURFACES.find((s) => s.surface === surface)?.label ?? surface
            return (
              <button
                key={surface}
                aria-current={isActive ? 'page' : undefined}
                disabled={!project}
                className={sidebarItemClass(isActive)}
                onClick={() => {
                  if (!project) return
                  onNavigateSurface(surface)
                }}
              >
                <span
                  aria-hidden="true"
                  className="grid h-4 w-4 shrink-0 place-items-center text-[14px] font-bold"
                >
                  {glyph}
                </span>
                <span>{label}</span>
              </button>
            )
          })}
        </div>
      </nav>

      {/* Agent Directory content — rendered by the shell in project view.
          flex-1 makes the directory fill available space so the Attention
          button sits at the bottom without a separate spacer that could
          intercept pointer events. */}
      {children && (
        <>
          <div
            aria-hidden="true"
            className="mx-2 my-0.5 h-px bg-line"
          />
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </>
      )}

      {/* Attention button — pinned to bottom */}
      <div className="shrink-0 px-2 pb-2 pt-1">
        <button
          aria-label="Global Attention"
          className={`${sidebarItemClass(showAttention)} justify-center`}
          onClick={onOpenAttention}
        >
          <span className="grid h-[17px] min-w-[17px] place-items-center rounded-full bg-attention-red px-1 text-[10px] font-bold text-paper">
            {attentionCount}
          </span>
          <span>关注</span>
        </button>
      </div>
    </aside>
  )
}
