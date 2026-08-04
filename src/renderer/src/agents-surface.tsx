import type {
  AgentInstanceId,
  CommandResult,
  LayoutOperation,
  ProjectViewModel,
  WorkbenchCommandBody,
  WorkbenchPort,
  WorkbenchViewModel
} from './workbench/contract'
import { WorkspaceArea } from './workspace-layout'

/**
 * Agents surface — the split-tree workspace with unique Agent Tabs (see
 * `workspace-layout.tsx`). The Agent Directory moved to the shell-level
 * fixed context pane in #66 (`context-pane.tsx`); this surface renders the
 * workspace only, and everything it needs is injected by the shell so the
 * pane and the workspace stay siblings under one layout-command path.
 *
 * All facts come from the WorkbenchPort snapshot; every mutation is a
 * typed command sent through the port. The renderer never keys interactions
 * by provider id, array index or panel id — only AgentInstanceId.
 */

export type SendCommand = (
  body: WorkbenchCommandBody,
  expectedRevision?: number
) => Promise<CommandResult>

export type PlanDispatch = WorkbenchPort['planDispatch']

// ---------------------------------------------------------------------------
// Agents surface
// ---------------------------------------------------------------------------

export function AgentsSurface({
  project,
  snapshot,
  openAttentionTargets,
  planDispatch,
  sendCommand,
  sendLayout,
  onFocusExitFallback
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  openAttentionTargets: Set<string>
  planDispatch: PlanDispatch
  sendCommand: SendCommand
  /**
   * The shell's single layout-command path (#66): shared with the context
   * pane, so a rejection always restores the authoritative layout and
   * surfaces a recoverable notice (Issue #4 AC4) instead of being dropped
   * silently. Commands bind to the revision of the render the user acted
   * on; stale renders stale-reject instead of overwriting a newer layout.
   */
  sendLayout: (operation: LayoutOperation) => Promise<CommandResult>
  /**
   * Focus return path into the context-pane directory (#66) — used when a
   * Focus exit prunes the Panel under the cursor.
   */
  onFocusExitFallback: (agentInstanceId?: AgentInstanceId) => void
}) {
  return (
    <section
      role="region"
      aria-label="Agent 工作区"
      className="relative flex h-full min-h-0"
    >
      <WorkspaceArea
        project={project}
        snapshot={snapshot}
        openAttentionTargets={openAttentionTargets}
        planDispatch={planDispatch}
        sendLayout={sendLayout}
        sendCommand={sendCommand}
        onFocusExitFallback={onFocusExitFallback}
      />
    </section>
  )
}
