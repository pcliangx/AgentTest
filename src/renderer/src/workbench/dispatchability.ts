/**
 * Shared dispatchability rule (#6 P3-3).
 *
 * Both the renderer (Agent Picker / `@@all` expansion) and the adapter
 * (confirm-dispatch acceptance) must agree on which instances may receive a
 * dispatch. Duplicating the rule lets one side accept a target the other then
 * rejects, so the predicate lives in the domain layer and is imported by both.
 */
import type {
  AgentInstanceViewModel,
  ProjectViewModel,
  TerminalState
} from './contract'

export type DispatchBlockReason = 'agent-unavailable'
export type ProjectDispatchBlockReason = 'project-archived'

/** Returns why a Project cannot accept new execution-producing commands. */
export function getProjectDispatchBlockReason(
  project: Pick<ProjectViewModel, 'lifecycle'>
): ProjectDispatchBlockReason | undefined {
  return project.lifecycle === 'archived' ? 'project-archived' : undefined
}

/** Opening reserves the PTY slot before the Terminal becomes fully active. */
export function isTerminalExecutionSlotOccupied(
  terminalState: TerminalState
): boolean {
  return terminalState === 'opening' || terminalState === 'active'
}

/** Returns the authoritative reason an instance cannot receive a dispatch. */
export function getDispatchBlockReason(
  a: AgentInstanceViewModel
): DispatchBlockReason | undefined {
  if (a.runtimeState === 'unavailable' || a.runtimeState === 'archived') {
    return 'agent-unavailable'
  }
  return undefined
}

/**
 * An instance can accept a Dispatch when it is not Provider-down or archived.
 * Terminal takeover occupies the execution slot, but does not prevent new work
 * from being accepted into the visible queue (ADR-0009 §显式执行与并发).
 */
export function isDispatchable(a: AgentInstanceViewModel): boolean {
  return getDispatchBlockReason(a) === undefined
}

/**
 * True when an instance's execution slot is occupied — by a structured Run or
 * Terminal takeover — or when it already has queued work. A further Dispatch
 * must enqueue rather than start immediately. The Agent Tab composer applies
 * its stricter Terminal mutex before consulting this helper.
 */
export function isAgentBusy(a: {
  runtimeState: string
  terminalState?: TerminalState
  activeRunId?: unknown
  queueDepth?: number
}): boolean {
  return (
    (a.terminalState !== undefined &&
      isTerminalExecutionSlotOccupied(a.terminalState)) ||
    a.activeRunId !== undefined ||
    (a.queueDepth ?? 0) > 0 ||
    a.runtimeState === 'running' ||
    a.runtimeState === 'starting' ||
    a.runtimeState === 'finishing' ||
    a.runtimeState === 'needs-input' ||
    a.runtimeState === 'permission-requested' ||
    a.runtimeState === 'queued'
  )
}
