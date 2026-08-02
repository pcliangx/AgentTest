/**
 * WorkbenchPort contract — the renderer's sole business seam.
 *
 * All types are defined by the Phase 1 spec
 * (`.scratch/ui-first-command-center/spec.md`). The contract may gain fields
 * but must never drop stable IDs, revision, correlation, rejection reasons or
 * frozen state semantics.
 */

// ---------------------------------------------------------------------------
// Branded IDs — stable, opaque, non-interchangeable
// ---------------------------------------------------------------------------

export type Brand<T, Name extends string> = T & { readonly __brand: Name }

export type ProjectId = Brand<string, 'ProjectId'>
export type AgentProviderId = Brand<string, 'AgentProviderId'>
export type AgentInstanceId = Brand<string, 'AgentInstanceId'>
export type RunId = Brand<string, 'RunId'>
export type DispatchId = Brand<string, 'DispatchId'>
export type HandoffId = Brand<string, 'HandoffId'>
export type ConnectionId = Brand<string, 'ConnectionId'>
export type PanelId = Brand<string, 'PanelId'>
export type SplitNodeId = Brand<string, 'SplitNodeId'>
export type AttentionItemId = Brand<string, 'AttentionItemId'>
export type CommandId = Brand<string, 'CommandId'>
export type PermissionRequestId = Brand<string, 'PermissionRequestId'>
export type ConfirmationId = Brand<string, 'ConfirmationId'>
export type QueueItemId = Brand<string, 'QueueItemId'>
export type ExternalResourceId = Brand<string, 'ExternalResourceId'>
export type ProjectTaskId = Brand<string, 'ProjectTaskId'>
export type ExternalTaskId = Brand<string, 'ExternalTaskId'>
export type KnowledgeResourceId = Brand<string, 'KnowledgeResourceId'>
export type ActivityId = Brand<string, 'ActivityId'>

/** Brands a raw string into a branded ID (cast helper). */
export function id<T extends string, Name extends string>(
  value: T,
  _name: Name
): Brand<T, Name> {
  return value as Brand<T, Name>
}

// ---------------------------------------------------------------------------
// State unions
// ---------------------------------------------------------------------------

export type ProjectSurface =
  | 'overview'
  | 'agents'
  | 'tasks'
  | 'knowledge'
  | 'handoffs'
  | 'activity'
  | 'settings'

export type ProjectLifecycle = 'active' | 'archived'
export type RootAvailability = 'available' | 'unavailable'
export type RepositoryReadiness = 'ready' | 'not-ready'
export type ProjectActivity = 'idle' | 'active'

export type AgentRuntimeState =
  | 'ready'
  | 'queued'
  | 'starting'
  | 'running'
  | 'finishing'
  | 'needs-input'
  | 'permission-requested'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unavailable'
  | 'archived'

export type TerminalState = 'closed' | 'opening' | 'active' | 'failed'
export type PermissionDecision = 'deny' | 'allow-once' | 'allow-current-run'
export type GlobalSurface = 'connections' | 'provider-health' | 'global-settings'

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export type LayoutNode =
  | { kind: 'panel'; panelId: PanelId }
  | {
      kind: 'split'
      splitNodeId: SplitNodeId
      direction: 'horizontal' | 'vertical'
      ratio: number
      first: LayoutNode
      second: LayoutNode
    }

export interface WorkspaceLayoutViewModel {
  root: LayoutNode | null
  panels: Record<
    PanelId,
    {
      tabs: AgentInstanceId[]
      activeTabId?: AgentInstanceId
    }
  >
  focusedPanelId?: PanelId
  temporaryFocusPanelId?: PanelId
}

export interface ProjectViewModel {
  projectId: ProjectId
  name: string
  lifecycle: ProjectLifecycle
  rootAvailability: RootAvailability
  repositoryReadiness: RepositoryReadiness
  activity: ProjectActivity
  activeRunCount: number
  queuedRunCount: number
  attentionCount: number
  primaryConnectionId?: ConnectionId
  currentSurface: ProjectSurface
  layout: WorkspaceLayoutViewModel
}

export interface AgentInstanceViewModel {
  agentInstanceId: AgentInstanceId
  projectId: ProjectId
  name: string
  providerId: AgentProviderId
  runtimeState: AgentRuntimeState
  terminalState: TerminalState
  activeRunId?: RunId
  queueDepth: number
  doctor: 'ready' | 'blocked'
}

export type ConfigurationOwner =
  | { kind: 'project'; projectId: ProjectId }
  | { kind: 'agent'; agentInstanceId: AgentInstanceId }

export interface ConfigurationDraftViewModel {
  owner: ConfigurationOwner
  appliedVersion: number
  changes: Array<{ fieldPath: string; applied: unknown; draft: unknown }>
  validationErrors: Array<{ fieldPath?: string; message: string }>
}

export interface QueueItemViewModel {
  queueItemId: QueueItemId
  projectId: ProjectId
  agentInstanceId: AgentInstanceId
  position: number
  priority: 'low' | 'normal' | 'high'
}

export interface PermissionRequestViewModel {
  requestId: PermissionRequestId
  projectId: ProjectId
  agentInstanceId: AgentInstanceId
  runId: RunId
  reason: string
  expiresAt: number
  decisions: PermissionDecision[]
}

export type AttentionTarget =
  | { kind: 'project'; projectId: ProjectId }
  | { kind: 'agent'; projectId: ProjectId; agentInstanceId: AgentInstanceId }
  | {
      kind: 'run'
      projectId: ProjectId
      agentInstanceId: AgentInstanceId
      runId: RunId
    }
  | { kind: 'project-task'; projectId: ProjectId; projectTaskId: ProjectTaskId }
  | {
      kind: 'external-task'
      projectId: ProjectId
      externalTaskId: ExternalTaskId
    }
  | {
      kind: 'knowledge'
      projectId: ProjectId
      knowledgeResourceId: KnowledgeResourceId
    }
  | { kind: 'handoff'; projectId: ProjectId; handoffId: HandoffId }

export interface AttentionItemViewModel {
  attentionItemId: AttentionItemId
  target: AttentionTarget
  state: 'open' | 'resolved'
  title: string
}

export interface ConfirmationViewModel {
  confirmationId: ConfirmationId
  action: string
  target: string
  impact: string
  nonBypassableReason: string
}

export interface ActivityEntry {
  activityId: ActivityId
  projectId: ProjectId
  agentInstanceId?: AgentInstanceId
  timestamp: number
  kind: string
  summary: string
}

export interface WorkbenchViewModel {
  schemaVersion: 1
  revision: number
  activeProjectId?: ProjectId
  activeGlobalSurface?: GlobalSurface
  projects: ProjectViewModel[]
  agents: AgentInstanceViewModel[]
  queue: QueueItemViewModel[]
  permissionRequests: PermissionRequestViewModel[]
  attentionItems: AttentionItemViewModel[]
  pendingConfirmation?: ConfirmationViewModel
  configurationDrafts: ConfigurationDraftViewModel[]
  activity: ActivityEntry[]
  global: {
    attentionCount: number
    concurrency: {
      perAgentLimit: 1
      projectLimit: 3
      globalLimit: 6
      activeGlobal: number
      queuedGlobal: number
    }
    connections: Array<{
      connectionId: ConnectionId
      label: string
      status: 'connected' | 'disconnected' | 'offline' | 'error'
    }>
    providers: Array<{ providerId: AgentProviderId; status: 'ready' | 'blocked' }>
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface CommandMeta {
  commandId: CommandId
  expectedRevision: number
}

export type LayoutOperation =
  | { kind: 'open-tab'; panelId: PanelId; agentInstanceId: AgentInstanceId }
  | { kind: 'activate-tab'; panelId: PanelId; agentInstanceId: AgentInstanceId }
  | { kind: 'close-tab'; panelId: PanelId; agentInstanceId: AgentInstanceId }
  | { kind: 'move-tab'; agentInstanceId: AgentInstanceId; targetPanelId: PanelId }
  | {
      kind: 'split-panel'
      panelId: PanelId
      direction: 'horizontal' | 'vertical'
    }
  | { kind: 'resize-split'; splitNodeId: SplitNodeId; ratio: number }
  | { kind: 'focus-panel'; panelId?: PanelId }
  | { kind: 'prune-empty-panels' }

export type WorkbenchCommand = CommandMeta &
  (
    | { kind: 'navigate-global'; surface: GlobalSurface }
    | { kind: 'navigate'; projectId: ProjectId; surface: ProjectSurface }
    | { kind: 'change-layout'; projectId: ProjectId; operation: LayoutOperation }
    | {
        kind: 'send-agent-instruction'
        projectId: ProjectId
        agentInstanceId: AgentInstanceId
        instruction: string
        mode: 'start-or-queue' | 'reply-current-run'
      }
    | {
        kind: 'set-terminal-takeover'
        projectId: ProjectId
        agentInstanceId: AgentInstanceId
        operation: 'open' | 'close'
      }
    | {
        kind: 'confirm-dispatch'
        projectId: ProjectId
        targets: AgentInstanceId[]
        instruction: string
      }
    | {
        kind: 'manage-queue'
        projectId: ProjectId
        queueItemId: QueueItemId
        operation:
          | 'cancel'
          | 'move-earlier'
          | 'move-later'
          | 'raise-priority'
          | 'lower-priority'
      }
    | {
        kind: 'answer-permission'
        projectId: ProjectId
        agentInstanceId: AgentInstanceId
        runId: RunId
        requestId: PermissionRequestId
        decision: PermissionDecision
      }
    | { kind: 'resolve-attention'; attentionItemId: AttentionItemId }
    | {
        kind: 'stage-configuration'
        owner: ConfigurationOwner
        fieldPath: string
        value: unknown
      }
    | { kind: 'discard-configuration'; owners: ConfigurationOwner[] }
    | {
        kind: 'apply-configuration'
        owners: Array<{ owner: ConfigurationOwner; expectedAppliedVersion: number }>
      }
    | {
        kind: 'import-handoff'
        projectId: ProjectId
        handoffId: HandoffId
        targetAgentInstanceId: AgentInstanceId
        mode: 'inspect-only'
      }
    | {
        kind: 'import-handoff'
        projectId: ProjectId
        handoffId: HandoffId
        targetAgentInstanceId: AgentInstanceId
        mode: 'execute-confirmed'
        confirmationId: ConfirmationId
      }
    | { kind: 'request-quit-preview' }
    | { kind: 'confirm-dangerous-action'; confirmationId: ConfirmationId }
  )

// ---------------------------------------------------------------------------
// Results & events
// ---------------------------------------------------------------------------

export type CommandRejectionReason =
  | 'stale-revision'
  | 'invalid-target'
  | 'invariant-violation'
  | 'unavailable'
  | 'busy'
  | 'confirmation-required'
  | 'not-enforceable'
  | 'scenario-read-only'

export type CommandResult =
  | { ok: true; commandId: CommandId; acceptedRevision: number }
  | {
      ok: false
      commandId: CommandId
      reason: CommandRejectionReason
      latestRevision: number
      message: string
    }

export type WorkbenchEvent =
  | {
      kind: 'view-model-updated'
      revision: number
      correlationId?: CommandId
      snapshot: WorkbenchViewModel
    }
  | {
      kind: 'run-state-changed'
      revision: number
      projectId: ProjectId
      agentInstanceId: AgentInstanceId
      runId: RunId
      state: AgentRuntimeState
    }
  | {
      kind: 'permission-requested'
      revision: number
      projectId: ProjectId
      agentInstanceId: AgentInstanceId
      runId: RunId
      requestId: PermissionRequestId
    }
  | {
      kind: 'dispatch-created'
      revision: number
      correlationId: CommandId
      dispatchIds: DispatchId[]
    }
  | {
      kind: 'attention-changed'
      revision: number
      attentionItemId: AttentionItemId
      state: 'open' | 'resolved'
    }
  | {
      kind: 'configuration-applied'
      revision: number
      correlationId: CommandId
      owners: Array<{ owner: ConfigurationOwner; appliedVersion: number }>
    }
  | {
      kind: 'handoff-imported'
      revision: number
      correlationId: CommandId
      handoffId: HandoffId
      mode: 'inspect-only' | 'execute-confirmed'
    }
  | {
      kind: 'external-state-changed'
      revision: number
      projectId: ProjectId
      resourceId: ExternalResourceId
      state: 'offline' | 'conflict' | 'unavailable'
    }
  | {
      kind: 'command-rejected'
      revision: number
      result: Extract<CommandResult, { ok: false }>
    }

// ---------------------------------------------------------------------------
// Port — the renderer's sole business seam
// ---------------------------------------------------------------------------

export interface WorkbenchPort {
  getSnapshot(): Promise<WorkbenchViewModel>
  dispatch(command: WorkbenchCommand): Promise<CommandResult>
  subscribe(listener: (event: WorkbenchEvent) => void): () => void
}
