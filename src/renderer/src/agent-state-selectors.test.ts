// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { AgentInstanceViewModel, AgentRuntimeState } from './workbench/contract'
import { id } from './workbench/contract'
import {
  agentDisplayState,
  isActiveRun,
  isBlocking,
  deriveProjectAgentStats,
  AGENT_DISPLAY_STATE_LABEL,
  type AgentDisplayState
} from './agent-state-selectors'

function makeAgent(
  runtimeState: AgentRuntimeState
): AgentInstanceViewModel {
  return {
    agentInstanceId: id(`agent-${runtimeState}`, 'AgentInstanceId'),
    projectId: id('p1', 'ProjectId'),
    name: `agent-${runtimeState}`,
    providerId: id('claude-code', 'AgentProviderId'),
    runtimeState,
    terminalState: 'closed',
    worktreeMode: 'isolated',
    queueDepth: 0,
    doctor: 'ready'
  }
}

describe('agentDisplayState — 12 runtime states collapse onto 6 display states', () => {
  const cases: Array<[AgentRuntimeState, AgentDisplayState]> = [
    ['starting', 'running'],
    ['running', 'running'],
    ['finishing', 'running'],
    ['needs-input', 'waiting-user'],
    ['permission-requested', 'waiting-permission'],
    ['queued', 'queued'],
    ['ready', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'failed'],
    ['interrupted', 'failed'],
    ['unavailable', 'unavailable'],
    ['archived', 'archived']
  ]
  for (const [runtime, expected] of cases) {
    it(`${runtime} → ${expected}`, () => {
      expect(agentDisplayState(runtime)).toBe(expected)
    })
  }
})

describe('isActiveRun', () => {
  it('true for starting / running / finishing', () => {
    expect(isActiveRun('starting')).toBe(true)
    expect(isActiveRun('running')).toBe(true)
    expect(isActiveRun('finishing')).toBe(true)
  })
  it('false for everything else', () => {
    expect(isActiveRun('ready')).toBe(false)
    expect(isActiveRun('queued')).toBe(false)
    expect(isActiveRun('needs-input')).toBe(false)
    expect(isActiveRun('permission-requested')).toBe(false)
    expect(isActiveRun('failed')).toBe(false)
  })
})

describe('isBlocking', () => {
  it('true for waiting-user / waiting-permission / failed states', () => {
    expect(isBlocking('needs-input')).toBe(true)
    expect(isBlocking('permission-requested')).toBe(true)
    expect(isBlocking('failed')).toBe(true)
    expect(isBlocking('cancelled')).toBe(true)
    expect(isBlocking('interrupted')).toBe(true)
  })
  it('false for running / queued / completed / unavailable', () => {
    expect(isBlocking('running')).toBe(false)
    expect(isBlocking('queued')).toBe(false)
    expect(isBlocking('ready')).toBe(false)
    expect(isBlocking('unavailable')).toBe(false)
  })
})

describe('AGENT_DISPLAY_STATE_LABEL — every display state has a label', () => {
  it('has exactly 8 entries (6 display + 2 edge)', () => {
    const keys = Object.keys(AGENT_DISPLAY_STATE_LABEL)
    expect(keys).toHaveLength(8)
  })

  it('uses "排队中" not "排队" for queued state', () => {
    expect(AGENT_DISPLAY_STATE_LABEL.queued).toBe('排队中')
  })
})

describe('deriveProjectAgentStats — consistent counts from agent list', () => {
  it('counts all non-archived agents', () => {
    const agents = [
      makeAgent('running'),
      makeAgent('queued'),
      makeAgent('ready'),
      makeAgent('archived') // excluded
    ]
    const stats = deriveProjectAgentStats(agents)
    expect(stats.total).toBe(3)
    expect(stats.running).toBe(1)
    expect(stats.queued).toBe(1)
    expect(stats.completed).toBe(1)
  })

  it('separates waiting-user and waiting-permission', () => {
    const agents = [
      makeAgent('needs-input'),
      makeAgent('permission-requested'),
      makeAgent('failed')
    ]
    const stats = deriveProjectAgentStats(agents)
    expect(stats.waitingUser).toBe(1)
    expect(stats.waitingPermission).toBe(1)
    expect(stats.failed).toBe(1)
    expect(stats.blocking).toBe(3)
  })

  it('reports zero blocking for a healthy project', () => {
    const agents = [makeAgent('running'), makeAgent('ready'), makeAgent('queued')]
    const stats = deriveProjectAgentStats(agents)
    expect(stats.blocking).toBe(0)
  })

  it('handles empty agent list', () => {
    const stats = deriveProjectAgentStats([])
    expect(stats).toEqual({
      total: 0,
      running: 0,
      waitingUser: 0,
      waitingPermission: 0,
      queued: 0,
      completed: 0,
      failed: 0,
      unavailable: 0,
      blocking: 0
    })
  })
})
