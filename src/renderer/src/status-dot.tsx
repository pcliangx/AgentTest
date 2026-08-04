import type { AgentRuntimeState } from './workbench/contract'

/**
 * The single global status-dot (issue #65): every Agent state indicator in
 * the renderer renders through this component. Color and shape are
 * double-coded (UX-v0.2 §15) — the six visual states deliberately collapse
 * the twelve runtime states into the frozen baseline's six families.
 */
export type StatusDotState =
  | 'running'
  | 'queued'
  | 'attention'
  | 'ready'
  | 'unavailable'
  | 'archived'

/** Chinese, user-facing — mirrors the visual double-encoding. */
export const STATUS_DOT_LABEL: Record<StatusDotState, string> = {
  running: '运行中',
  queued: '排队中',
  attention: '需要处理',
  ready: '就绪',
  unavailable: '不可用',
  archived: '已归档'
}

/**
 * Collapses the twelve AgentRuntimeState values onto the six status-dot
 * families. States that need user observation (needs-input, permission,
 * failed, cancelled, interrupted) share the amber attention square;
 * `unavailable` stays a Provider-health fact, never an attention alias.
 */
export function statusDotState(
  runtimeState: AgentRuntimeState
): StatusDotState {
  switch (runtimeState) {
    case 'starting':
    case 'running':
    case 'finishing':
      return 'running'
    case 'queued':
      return 'queued'
    case 'needs-input':
    case 'permission-requested':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
      return 'attention'
    case 'unavailable':
      return 'unavailable'
    case 'archived':
      return 'archived'
    case 'ready':
      return 'ready'
  }
}

export function StatusDot({
  state,
  label
}: {
  state: StatusDotState
  /**
   * When the dot stands alone (no adjacent state text), pass a label so the
   * state is also exposed through an accessible name. When adjacent text
   * already names the state, omit it and the dot is decorative only.
   */
  label?: string
}) {
  if (label !== undefined) {
    return (
      <span
        role="img"
        aria-label={label}
        className={`state-dot state-dot-${state}`}
      />
    )
  }
  return <span aria-hidden="true" className={`state-dot state-dot-${state}`} />
}
