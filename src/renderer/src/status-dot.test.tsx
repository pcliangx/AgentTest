// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AgentRuntimeState } from './workbench/contract'
import { STATUS_DOT_LABEL, StatusDot, statusDotState } from './status-dot'

describe('statusDotState — twelve runtime states collapse onto six families', () => {
  const cases: Array<[AgentRuntimeState, string]> = [
    ['starting', 'running'],
    ['running', 'running'],
    ['finishing', 'running'],
    ['queued', 'queued'],
    ['needs-input', 'attention'],
    ['permission-requested', 'attention'],
    ['failed', 'attention'],
    ['cancelled', 'attention'],
    ['interrupted', 'attention'],
    ['ready', 'ready'],
    ['unavailable', 'unavailable'],
    ['archived', 'archived']
  ]

  it.each(cases)('maps %s to %s', (runtimeState, expected) => {
    expect(statusDotState(runtimeState)).toBe(expected)
  })

  it('covers every runtime state exactly once', () => {
    const all: AgentRuntimeState[] = [
      'ready',
      'queued',
      'starting',
      'running',
      'finishing',
      'needs-input',
      'permission-requested',
      'failed',
      'cancelled',
      'interrupted',
      'unavailable',
      'archived'
    ]
    expect(cases.map(([runtimeState]) => runtimeState).sort()).toEqual(
      all.sort()
    )
  })
})

describe('StatusDot', () => {
  it('renders the state modifier class for shape double-encoding', () => {
    const { container } = render(<StatusDot state="attention" />)
    const dot = container.querySelector('.state-dot')
    expect(dot).not.toBeNull()
    expect(dot).toHaveClass('state-dot-attention')
  })

  it('is decorative when adjacent text already names the state', () => {
    const { container } = render(<StatusDot state="running" />)
    expect(container.querySelector('.state-dot')).toHaveAttribute(
      'aria-hidden',
      'true'
    )
  })

  it('exposes an accessible name when it stands alone', () => {
    render(<StatusDot state="ready" label={STATUS_DOT_LABEL.ready} />)
    expect(screen.getByRole('img', { name: '就绪' })).toBeVisible()
  })

  it('provides a Chinese label for each of the six states', () => {
    for (const state of [
      'running',
      'queued',
      'attention',
      'ready',
      'unavailable',
      'archived'
    ] as const) {
      expect(STATUS_DOT_LABEL[state]).toBeTruthy()
    }
  })
})
