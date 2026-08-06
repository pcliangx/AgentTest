import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import type {
  GlobalSurface,
  ProjectId,
  ProjectViewModel
} from './workbench/contract'

/**
 * The persistent top quick-switch bar (#75): global home entries (连接 /
 * Provider 健康 / 全局设置) on the left, then one button per Project, all
 * rendered at the same position on every surface so any destination is one
 * click away. It replaces the context pane's 切换项目 select (#66) and the
 * global view's ← 返回项目 button.
 *
 * Overflow: the bar shows as many Project buttons as the available width
 * allows and folds the rest into a keyboard-operable 更多 menu. Widths are
 * measured from an aria-hidden mirror row (the visible row only renders
 * what fits), recomputed on resize. In unmeasurable environments (jsdom,
 * first paint) every button stays visible.
 *
 * Switching semantics are unchanged: the same navigate / navigate-global
 * commands as the retired entries; the current destination is double-encoded
 * by weight + background and carries `aria-current="page"` (UX-v0.2 §15).
 */

const GLOBAL_ENTRIES: Array<{ surface: GlobalSurface; label: string }> = [
  { surface: 'connections', label: '连接' },
  { surface: 'provider-health', label: 'Provider 健康' },
  { surface: 'global-settings', label: '全局设置' }
]

/**
 * One item style shared by the global entries, the Project buttons and the
 * 更多 trigger so the bar can never drift apart. Active state adds weight
 * and a wash background — never color alone (UX-v0.2 §15).
 */
const switchBarItemClass = (isActive: boolean): string =>
  `h-[29px] shrink-0 rounded-lg px-2 text-[11px] transition-colors ${
    isActive
      ? 'bg-wash font-semibold text-ink'
      : 'text-muted hover:bg-wash hover:text-ink'
  }`

/** Horizontal gap between Project buttons / the 更多 trigger (gap-1). */
const ITEM_GAP = 4

/**
 * How many Project buttons fit. `availableWidth <= 0` means the environment
 * cannot measure (jsdom, pre-layout) — everything stays visible. When any
 * button overflows, room for the 更多 trigger is reserved; the trigger is
 * essential UI and renders even if nothing else fits.
 */
export function computeVisibleProjectCount(
  availableWidth: number,
  itemWidths: number[],
  moreWidth: number
): number {
  const total = itemWidths.length
  if (availableWidth <= 0 || total === 0) return total
  const rowWidth = (count: number, withMore: boolean): number => {
    let used = withMore ? moreWidth : 0
    for (let i = 0; i < count; i++) used += itemWidths[i]
    const gaps = count + (withMore ? 1 : 0) - 1
    return used + Math.max(0, gaps) * ITEM_GAP
  }
  if (rowWidth(total, false) <= availableWidth) return total
  let count = total - 1
  while (count > 0 && rowWidth(count, true) > availableWidth) count--
  return count
}

export function ProjectSwitchBar({
  projects,
  activeProjectId,
  activeGlobalSurface,
  onSwitchProject,
  onNavigateGlobal
}: {
  projects: ProjectViewModel[]
  /** Undefined while a global work surface is active. */
  activeProjectId: ProjectId | undefined
  activeGlobalSurface: GlobalSurface | undefined
  onSwitchProject: (projectId: ProjectId) => void
  onNavigateGlobal: (surface: GlobalSurface) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(projects.length)

  const recompute = useCallback(() => {
    const container = containerRef.current
    const measurer = measureRef.current
    if (!container || !measurer) return
    const itemWidths = Array.from(
      measurer.querySelectorAll<HTMLElement>('[data-switch-item]')
    ).map((element) => element.offsetWidth)
    const moreWidth =
      measurer.querySelector<HTMLElement>('[data-switch-more]')?.offsetWidth ??
      0
    setVisibleCount((previous) => {
      const next = computeVisibleProjectCount(
        container.clientWidth,
        itemWidths,
        moreWidth
      )
      return previous === next ? previous : next
    })
  }, [])

  // Re-measure whenever the project set (and thus the mirror row) changes.
  useLayoutEffect(() => {
    recompute()
  }, [recompute, projects])

  useEffect(() => {
    const container = containerRef.current
    if (typeof ResizeObserver === 'undefined' || !container) return
    const observer = new ResizeObserver(recompute)
    observer.observe(container)
    return () => observer.disconnect()
  }, [recompute])

  const visibleProjects = projects.slice(0, visibleCount)
  const overflowProjects = projects.slice(visibleCount)

  const renderProjectButton = (project: ProjectViewModel) => {
    const isActive = project.projectId === activeProjectId
    return (
      <button
        key={project.projectId}
        data-switch-item
        aria-current={isActive ? 'page' : undefined}
        title={project.name}
        className={`${switchBarItemClass(isActive)} max-w-[140px]`}
        onClick={() => onSwitchProject(project.projectId)}
      >
        <span className="block truncate">{project.name}</span>
      </button>
    )
  }

  return (
    <nav
      aria-label="快捷切换"
      className="flex min-w-0 flex-1 items-center gap-2"
    >
      <div
        role="group"
        aria-label="全局工作面"
        className="flex shrink-0 items-center gap-1"
      >
        {GLOBAL_ENTRIES.map(({ surface, label }) => (
          <button
            key={surface}
            aria-current={
              activeGlobalSurface === surface ? 'page' : undefined
            }
            className={switchBarItemClass(activeGlobalSurface === surface)}
            onClick={() => onNavigateGlobal(surface)}
          >
            {label}
          </button>
        ))}
      </div>
      {projects.length > 0 && (
        <>
          <span aria-hidden="true" className="h-5 w-px shrink-0 bg-line" />
          <div
            ref={containerRef}
            className="flex min-w-0 flex-1 items-center gap-1"
          >
            {visibleProjects.map(renderProjectButton)}
            {overflowProjects.length > 0 && (
              <OverflowMenu
                projects={overflowProjects}
                activeProjectId={activeProjectId}
                onSwitchProject={onSwitchProject}
              />
            )}
          </div>
          {/* Mirror row for width measurement: identical items, never
              visible or focusable. jsdom reports zero widths, which
              computeVisibleProjectCount treats as "show everything". */}
          <div
            ref={measureRef}
            aria-hidden="true"
            className="pointer-events-none absolute flex items-center gap-1 whitespace-nowrap opacity-0"
          >
            {projects.map((project) => (
              <span
                key={project.projectId}
                data-switch-item
                className={`${switchBarItemClass(false)} inline-block max-w-[140px]`}
              >
                <span className="block truncate">{project.name}</span>
              </span>
            ))}
            <span
              data-switch-more
              className={`${switchBarItemClass(false)} inline-block`}
            >
              更多
            </span>
          </div>
        </>
      )}
    </nav>
  )
}

function OverflowMenu({
  projects,
  activeProjectId,
  onSwitchProject
}: {
  projects: ProjectViewModel[]
  activeProjectId: ProjectId | undefined
  onSwitchProject: (projectId: ProjectId) => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const containsActive = projects.some(
    (project) => project.projectId === activeProjectId
  )

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (
        menuRef.current &&
        event.target instanceof Node &&
        !menuRef.current.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      ) {
        close(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, close])

  const focusItem = (index: number) => {
    const items = menuRef.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]'
    )
    if (!items || items.length === 0) return
    items[Math.max(0, Math.min(index, items.length - 1))]?.focus()
  }

  const openMenu = (focusFirst: boolean) => {
    setOpen(true)
    if (focusFirst) {
      // Focus moves once the menu has rendered.
      requestAnimationFrame(() => focusItem(0))
    }
  }

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        data-switch-more
        aria-haspopup="menu"
        aria-expanded={open}
        // The label names the menu's content even when the current Project
        // sits inside it — the active encoding (weight + background) doubles
        // that fact for sighted users.
        aria-label={containsActive ? '更多项目（含当前项目）' : '更多项目'}
        title={containsActive ? '更多项目（含当前项目）' : '更多项目'}
        className={switchBarItemClass(containsActive)}
        onClick={() => (open ? close(false) : openMenu(false))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            openMenu(true)
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            close(true)
          }
        }}
      >
        更多 ▾
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="更多项目"
          className="absolute right-0 top-full z-30 mt-1 min-w-[160px] rounded-[10px] border border-line bg-paper p-1 shadow-overlay"
          onKeyDown={(event) => {
            const items = Array.from(
              menuRef.current?.querySelectorAll<HTMLElement>(
                '[role="menuitem"]'
              ) ?? []
            )
            const index = items.findIndex(
              (item) => item === document.activeElement
            )
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              focusItem(index + 1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              focusItem(index <= 0 ? items.length - 1 : index - 1)
            } else if (event.key === 'Home') {
              event.preventDefault()
              focusItem(0)
            } else if (event.key === 'End') {
              event.preventDefault()
              focusItem(items.length - 1)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close(true)
            } else if (event.key === 'Tab') {
              close(false)
            }
          }}
        >
          {projects.map((project) => {
            const isActive = project.projectId === activeProjectId
            return (
              <button
                key={project.projectId}
                role="menuitem"
                aria-current={isActive ? 'page' : undefined}
                title={project.name}
                className={`block w-full truncate rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors ${
                  isActive
                    ? 'bg-wash font-semibold text-ink'
                    : 'text-muted hover:bg-wash hover:text-ink'
                }`}
                onClick={() => {
                  onSwitchProject(project.projectId)
                  close(true)
                }}
              >
                {project.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
