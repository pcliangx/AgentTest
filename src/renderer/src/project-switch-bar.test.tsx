// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  computeVisibleProjectCount,
  ProjectSwitchBar
} from './project-switch-bar'
import { id } from './workbench/contract'
import type { ProjectViewModel } from './workbench/contract'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function fakeProject(projectId: string, name: string): ProjectViewModel {
  return { projectId: id(projectId, 'ProjectId'), name } as ProjectViewModel
}

const PROJECTS = [
  fakeProject('proj-a', '销售数据分析'),
  fakeProject('proj-b', '用户研究'),
  fakeProject('proj-c', '增长实验平台')
]

function renderBar(
  overrides: Partial<Parameters<typeof ProjectSwitchBar>[0]> = {}
) {
  const onSwitchProject = vi.fn()
  render(
    <ProjectSwitchBar
      projects={PROJECTS}
      activeProjectId={id('proj-a', 'ProjectId')}
      onSwitchProject={onSwitchProject}
      {...overrides}
    />
  )
  return { onSwitchProject }
}

/**
 * Force a measurable narrow bar: every Project button 80px wide, the 更多
 * trigger 60px, the container 150px — exactly one Project button fits.
 */
function mockNarrowWidths() {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(
    function (this: HTMLElement) {
      if (this.hasAttribute('data-switch-item')) return 80
      if (this.hasAttribute('data-switch-more')) return 60
      return 0
    }
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(150)
}

describe('computeVisibleProjectCount', () => {
  it('shows everything when the row fits', () => {
    expect(computeVisibleProjectCount(500, [80, 80, 80], 60)).toBe(3)
  })

  it('reserves room for the 更多 trigger once anything overflows', () => {
    // One button (80) + gap (4) + trigger (60) = 144 ≤ 150; two buttons
    // (228) do not fit.
    expect(computeVisibleProjectCount(150, [80, 80, 80], 60)).toBe(1)
    expect(computeVisibleProjectCount(228, [80, 80, 80], 60)).toBe(2)
  })

  it('still renders only the trigger when nothing else fits', () => {
    expect(computeVisibleProjectCount(70, [80, 80], 60)).toBe(0)
  })

  it('treats an unmeasurable width as "show everything" (jsdom)', () => {
    expect(computeVisibleProjectCount(0, [0, 0], 0)).toBe(2)
  })
})

describe('ProjectSwitchBar', () => {
  it('renders one button per project', () => {
    renderBar()
    const bar = screen.getByRole('navigation', { name: '快捷切换' })
    // #76: the global entries moved into the left navigation's App tier —
    // this bar is Projects only.
    expect(
      within(bar).queryByRole('button', { name: '连接' })
    ).not.toBeInTheDocument()
    for (const project of PROJECTS) {
      expect(
        within(bar).getByRole('button', { name: project.name })
      ).toBeVisible()
    }
    // Everything fits in jsdom — no overflow trigger.
    expect(
      within(bar).queryByRole('button', { name: /更多项目/ })
    ).not.toBeInTheDocument()
  })

  it('double-encodes the current project and marks it aria-current', () => {
    renderBar()
    const bar = screen.getByRole('navigation', { name: '快捷切换' })
    const active = within(bar).getByRole('button', { name: '销售数据分析' })
    expect(active).toHaveAttribute('aria-current', 'page')
    expect(active.className).toContain('font-semibold')
    expect(
      within(bar).getByRole('button', { name: '用户研究' })
    ).not.toHaveAttribute('aria-current')
  })

  it('marks nothing while a global work surface is active', () => {
    renderBar({ activeProjectId: undefined })
    const bar = screen.getByRole('navigation', { name: '快捷切换' })
    for (const project of PROJECTS) {
      expect(
        within(bar).getByRole('button', { name: project.name })
      ).not.toHaveAttribute('aria-current')
    }
  })

  it('switches project on click', async () => {
    const user = userEvent.setup()
    const { onSwitchProject } = renderBar()
    const bar = screen.getByRole('navigation', { name: '快捷切换' })
    await user.click(within(bar).getByRole('button', { name: '用户研究' }))
    expect(onSwitchProject).toHaveBeenCalledWith(id('proj-b', 'ProjectId'))
  })

  it('truncates long project names with a title fallback', () => {
    renderBar({
      projects: [fakeProject('proj-long', '一个名字特别特别长的项目空间')]
    })
    const button = within(
      screen.getByRole('navigation', { name: '快捷切换' })
    ).getByRole('button', { name: '一个名字特别特别长的项目空间' })
    expect(button.className).toContain('max-w-[140px]')
    expect(button).toHaveAttribute('title', '一个名字特别特别长的项目空间')
  })
})

describe('ProjectSwitchBar — overflow 更多 menu', () => {
  it('folds the projects that do not fit into the menu', async () => {
    mockNarrowWidths()
    const user = userEvent.setup()
    const { onSwitchProject } = renderBar()
    const bar = screen.getByRole('navigation', { name: '快捷切换' })
    // One button fits; the other two wait inside the menu.
    await waitFor(() => {
      expect(
        within(bar).getByRole('button', { name: /更多项目/ })
      ).toBeVisible()
    })
    expect(
      within(bar).getByRole('button', { name: '销售数据分析' })
    ).toBeVisible()
    expect(
      within(bar).queryByRole('button', { name: '用户研究' })
    ).not.toBeInTheDocument()

    await user.click(within(bar).getByRole('button', { name: /更多项目/ }))
    const menu = screen.getByRole('menu', { name: '更多项目' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('用户研究')
    expect(items[1]).toHaveTextContent('增长实验平台')

    await user.click(items[0])
    expect(onSwitchProject).toHaveBeenCalledWith(id('proj-b', 'ProjectId'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    // Focus returns to the trigger after activation.
    expect(
      within(bar).getByRole('button', { name: /更多项目/ })
    ).toHaveFocus()
  })

  it('keeps aria-current on the active project inside the menu', async () => {
    mockNarrowWidths()
    // The active project is the LAST one — it lands in the overflow menu.
    renderBar({ activeProjectId: id('proj-c', 'ProjectId') })
    const bar = screen.getByRole('navigation', { name: '快捷切换' })
    const trigger = await within(bar).findByRole('button', {
      name: '更多项目（含当前项目）'
    })
    // The trigger double-encodes that the current project is inside — and
    // carries aria-current while the menu is closed (PR #81 review).
    expect(trigger.className).toContain('font-semibold')
    expect(trigger).toHaveAttribute('aria-current', 'page')
    await userEvent.setup().click(trigger)
    const menu = screen.getByRole('menu', { name: '更多项目' })
    const activeItem = within(menu).getByRole('menuitem', {
      name: '增长实验平台'
    })
    expect(activeItem).toHaveAttribute('aria-current', 'page')
    expect(activeItem.className).toContain('font-semibold')
  })

  it('is fully keyboard operable (arrows, Enter, Escape)', async () => {
    mockNarrowWidths()
    const user = userEvent.setup()
    const { onSwitchProject } = renderBar()
    const bar = screen.getByRole('navigation', { name: '快捷切换' })
    const trigger = await within(bar).findByRole('button', {
      name: /更多项目/
    })

    // ArrowDown on the trigger opens the menu and focuses the first item.
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    const menu = await screen.findByRole('menu', { name: '更多项目' })
    const items = within(menu).getAllByRole('menuitem')
    await waitFor(() => expect(items[0]).toHaveFocus())

    // Arrow navigation wraps the roving focus around both ends.
    await user.keyboard('{ArrowDown}')
    expect(items[1]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(items[0]).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(items[1]).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(items[0]).toHaveFocus()

    // Escape closes and returns focus to the trigger.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    // Reopen and activate with Enter.
    await user.keyboard('{ArrowDown}')
    await screen.findByRole('menu', { name: '更多项目' })
    await waitFor(() =>
      expect(
        within(screen.getByRole('menu')).getAllByRole('menuitem')[0]
      ).toHaveFocus()
    )
    await user.keyboard('{Enter}')
    expect(onSwitchProject).toHaveBeenCalledWith(id('proj-b', 'ProjectId'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
