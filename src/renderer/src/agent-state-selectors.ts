/**
 * #97: Single source of truth for user-visible Agent states and derived
 * counts. Every renderer surface (Header, Overview, Agent Directory,
 * Workspace, statusbar) MUST go through these selectors — raw
 * AgentRuntimeState values or ad-hoc filter predicates are no longer
 * the right entry point for display.
 *
 * The six user-visible display states collapse the twelve
 * AgentRuntimeState values into the set that matters to a user:
 *
 * | display state    | runtime states                          |
 * |------------------|-----------------------------------------|
 * | running          | starting, running, finishing            |
 * | waiting-user     | needs-input                             |
 * | waiting-permission | permission-requested                   |
 * | queued           | queued                                  |
 * | completed        | ready                                   |
 * | failed           | failed, cancelled, interrupted          |
 *
 * `unavailable` and `archived` are edge-case states that fall outside
 * the six-family set; they map to themselves for completeness.
 */

import type { AgentInstanceViewModel, AgentRuntimeState } from './workbench/contract'

// ---------------------------------------------------------------------------
// User-visible display state
// ---------------------------------------------------------------------------

export type AgentDisplayState =
  | 'running'
  | 'waiting-user'
  | 'waiting-permission'
  | 'queued'
  | 'completed'
  | 'failed'
  | 'unavailable'
  | 'archived'

/** Chinese user-facing label per display state. */
export const AGENT_DISPLAY_STATE_LABEL: Record<AgentDisplayState, string> = {
  running: '运行中',
  'waiting-user': '等待用户',
  'waiting-permission': '等待权限',
  queued: '排队中',
  completed: '已完成',
  failed: '失败',
  unavailable: '不可用',
  archived: '已归档'
}

/**
 * Maps a runtime state to its user-visible display state — the single
 * function every consumer should use instead of ad-hoc if-cascades.
 */
export function agentDisplayState(
  runtimeState: AgentRuntimeState
): AgentDisplayState {
  switch (runtimeState) {
    case 'starting':
    case 'running':
    case 'finishing':
      return 'running'
    case 'needs-input':
      return 'waiting-user'
    case 'permission-requested':
      return 'waiting-permission'
    case 'queued':
      return 'queued'
    case 'ready':
      return 'completed'
    case 'failed':
    case 'cancelled':
    case 'interrupted':
      return 'failed'
    case 'unavailable':
      return 'unavailable'
    case 'archived':
      return 'archived'
  }
}

// ---------------------------------------------------------------------------
// Predicates — thin wrappers so call sites read as English intent
// ---------------------------------------------------------------------------

export function isActiveRun(state: AgentRuntimeState): boolean {
  return agentDisplayState(state) === 'running'
}

export function isBlocking(state: AgentRuntimeState): boolean {
  const ds = agentDisplayState(state)
  return ds === 'waiting-user' || ds === 'waiting-permission' || ds === 'failed'
}

// ---------------------------------------------------------------------------
// Derived project statistics — consistent counts from the agent list
// ---------------------------------------------------------------------------

export interface ProjectAgentStats {
  /** Total non-archived Agent instances. */
  total: number
  /** Agents with an active structured run (starting / running / finishing). */
  running: number
  /** Agents waiting for user input. */
  waitingUser: number
  /** Agents waiting for a permission decision. */
  waitingPermission: number
  /** Agents queued for execution. */
  queued: number
  /** Agents idle / ready (no active work). */
  completed: number
  /** Agents in a failure state (failed / cancelled / interrupted). */
  failed: number
  /** Agents whose Provider is blocked. */
  unavailable: number
  /** Convenience: waitingUser + waitingPermission + failed. */
  blocking: number
}

/**
 * Derives consistent project-level statistics from the agent list.
 * This replaces ad-hoc `project.activeRunCount` / `project.attentionCount`
 * in display contexts where the renderer's own agent list is the truth.
 *
 * Contract-owned counts (ProjectViewModel.activeRunCount etc.) remain the
 * authority for capacity enforcement and the statusbar capacity line.
 */
export function deriveProjectAgentStats(
  agents: AgentInstanceViewModel[]
): ProjectAgentStats {
  const stats: ProjectAgentStats = {
    total: 0,
    running: 0,
    waitingUser: 0,
    waitingPermission: 0,
    queued: 0,
    completed: 0,
    failed: 0,
    unavailable: 0,
    blocking: 0
  }
  for (const agent of agents) {
    if (agent.runtimeState === 'archived') continue
    stats.total++
    switch (agentDisplayState(agent.runtimeState)) {
      case 'running':
        stats.running++
        break
      case 'waiting-user':
        stats.waitingUser++
        stats.blocking++
        break
      case 'waiting-permission':
        stats.waitingPermission++
        stats.blocking++
        break
      case 'queued':
        stats.queued++
        break
      case 'completed':
        stats.completed++
        break
      case 'failed':
        stats.failed++
        stats.blocking++
        break
      case 'unavailable':
        stats.unavailable++
        break
    }
  }
  return stats
}
