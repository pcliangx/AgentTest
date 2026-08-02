/**
 * Shared dispatchability rule (#6 P3-3).
 *
 * Both the renderer (Agent Picker / `@@all` expansion) and the adapter
 * (confirm-dispatch acceptance) must agree on which instances may receive a
 * dispatch. Duplicating the rule lets one side accept a target the other then
 * rejects, so the predicate lives in the domain layer and is imported by both.
 */
import type { AgentInstanceViewModel } from './contract'

export type DispatchBlockReason = 'agent-unavailable' | 'terminal-active'

/** Returns the authoritative reason an instance cannot receive a dispatch. */
export function getDispatchBlockReason(
  a: AgentInstanceViewModel
): DispatchBlockReason | undefined {
  if (a.runtimeState === 'unavailable' || a.runtimeState === 'archived') {
    return 'agent-unavailable'
  }
  if (a.terminalState === 'active') return 'terminal-active'
  return undefined
}

/**
 * An instance is dispatchable when it is not Provider-down, not archived, and
 * not holding a Terminal takeover (ADR-0007 structured/PTY mutex).
 */
export function isDispatchable(a: AgentInstanceViewModel): boolean {
  return getDispatchBlockReason(a) === undefined
}

/**
 * True when an instance already holds an active structured Run — or already has
 * queued work — so a further dispatch/composer instruction must enqueue rather
 * than start immediately. Includes the `queued` state and any non-zero
 * queueDepth, otherwise already-queued work would silently fail to grow the
 * queue (#6 P1-2).
 */
export function isAgentBusy(a: {
  runtimeState: string
  activeRunId?: unknown
  queueDepth?: number
}): boolean {
  return (
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
