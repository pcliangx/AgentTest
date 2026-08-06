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
export type ResourceBindingId = Brand<string, 'ResourceBindingId'>
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
export type ChatEntryId = Brand<string, 'ChatEntryId'>
export type ExecutionResultId = Brand<string, 'ExecutionResultId'>

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
export type GlobalSurface =
  | 'home'
  | 'connections'
  | 'provider-health'
  | 'global-settings'
export type AgentOpenMode = 'current-panel' | 'background' | 'new-panel'
export type AgentWorktreeMode = 'isolated' | 'read-only-shared'

/**
 * Attention categories aggregated by the Global Attention Center (#9).
 * The list mirrors UX-v0.2 §10; it is extensible, never Provider-specific.
 */
export type AttentionItemKind =
  | 'permission-requested'
  | 'needs-input'
  | 'failed'
  | 'interrupted'
  | 'completed'
  | 'connection-conflict'
  | 'provider-unavailable'

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

export interface ResourceBindingViewModel {
  bindingId: ResourceBindingId
  connectionId: ConnectionId
  resourceType: 'task-list' | 'knowledge-space' | 'document' | 'other'
  label: string
  allowedOperations: Array<'read' | 'create' | 'update'>
}

export type KnowledgeContainerState =
  | 'online'
  | 'offline'
  | 'cached'
  | 'unavailable'
  | 'unconnected'

export type KnowledgeSecurityAction =
  | 'untrusted-link'
  | 'download'
  | 'popup'
  | 'permission-request'

/**
 * Phase 1 projection for the Knowledge browser container. It intentionally
 * carries display identities only: browser/Connector credentials, cookies,
 * profiles and raw authentication material never cross the WorkbenchPort.
 */
export interface KnowledgeContainerBaseViewModel {
  projectId: ProjectId
  knowledgeResourceId?: KnowledgeResourceId
  label?: string
  /**
   * Adapter-owned local-change truth. Attention may project this fact, but
   * resolving that projection never clears the underlying unsynced changes.
   */
  unsyncedChanges?: {
    summary: string
  }
  humanBrowserIdentity?: string
  connectionId?: ConnectionId
  connectorIdentity?: string
  resourceBindingId?: ResourceBindingId
  securityFeedback?: {
    action: KnowledgeSecurityAction
    message: string
  }
}

export interface KnowledgeCacheViewModel {
  version: string
  cachedAt: number
  readOnly: true
}

/**
 * A cached projection is only representable when its mandatory provenance is
 * present. Other states cannot accidentally retain stale cache metadata.
 */
export type KnowledgeContainerViewModel =
  | (KnowledgeContainerBaseViewModel & {
      state: 'cached'
      cache: KnowledgeCacheViewModel
    })
  | (KnowledgeContainerBaseViewModel & {
      state: Exclude<KnowledgeContainerState, 'cached'>
      cache?: never
    })

/**
 * Removes the discriminant payload before a projection changes state.
 * Keeping this transition shape in one place prevents stale cache metadata
 * from leaking into non-cached variants.
 */
export function stripKnowledgeContainerState({
  state: _state,
  cache: _cache,
  ...base
}: KnowledgeContainerViewModel): KnowledgeContainerBaseViewModel {
  return base
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
  /**
   * Project Root display path and current Git branch for the shell
   * statusbar (#65). Adapter-owned facts — the renderer never derives or
   * hard-codes them; optional only so older fixtures keep compiling.
   */
  rootPath?: string
  currentBranch?: string
  /**
   * Epoch ms of the last time this Project became the active one (#76).
   * Adapter-owned recency truth for the home page's 最近项目 list — the
   * renderer never derives or mutates it; optional only so older fixtures
   * keep compiling.
   */
  lastOpenedAt?: number
  primaryConnectionId?: ConnectionId
  /** Authoritative resource bindings scoped to the primary connection (#6). */
  resourceBindings: ResourceBindingViewModel[]
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
  worktreeMode: AgentWorktreeMode
  activeRunId?: RunId
  queueDepth: number
  doctor: 'ready' | 'blocked'
  /** Epoch ms of the instance's latest known activity, for recency ordering. */
  lastActivityAt?: number
  /**
   * Adapter-owned summary of the instance's current work item (#67),
   * displayed verbatim as the Chat view's 当前任务 context block. Absent
   * when no work item is known — the block is hidden, never fabricated.
   */
  currentTaskSummary?: string
  /**
   * Adapter-owned handoff facts that cannot be derived from runtime, Activity
   * or worktree projections. Renderer consumers display these facts verbatim.
   */
  handoffDirtyFlags?: {
    unsyncedTaskCount: number
    manuallyMarked: boolean
  }
  /**
   * The applied configuration version this instance's active Run started
   * with (Run 配置快照). Applying newer configuration never rewrites it —
   * run configuration only takes effect on the next Run (US-91).
   */
  activeRunConfigVersion?: number
}

/** Settings sections — the single edit locations readiness links back to. */
export type ConfigurationSectionKey =
  | 'general'
  | 'defaults'
  | 'instances'
  | 'integrations'
  | 'permissions'

export type ConfigurationOwner =
  | { kind: 'project'; projectId: ProjectId }
  | { kind: 'agent'; agentInstanceId: AgentInstanceId }

export interface ConfigurationDraftViewModel {
  owner: ConfigurationOwner
  appliedVersion: number
  changes: Array<{ fieldPath: string; applied: unknown; draft: unknown }>
  validationErrors: Array<{ fieldPath?: string; message: string }>
}

/**
 * The adapter-owned configuration truth for one owner: every configurable
 * field's applied value plus the monotonically increasing applied version.
 * The renderer never invents fields — it renders exactly what the port
 * exposes here, and drafts (`configurationDrafts`) only reference these
 * field paths.
 */
export interface AppliedConfigurationViewModel {
  owner: ConfigurationOwner
  appliedVersion: number
  /** fieldPath -> applied value for every configurable field of this owner. */
  values: Record<string, unknown>
}

/** Whether an applied value currently takes effect, as judged by the adapter. */
export type EffectiveValueStatus = 'effective' | 'blocked'

export interface EffectiveConfigurationEntry {
  fieldPath: string
  /** Pass-through of the applied truth value (may be undefined). */
  applied: unknown
  status: EffectiveValueStatus
  /** Chinese, user-facing — present iff status is 'blocked'. */
  blockedReason?: string
}

/** Per-owner applied/effective comparison for Settings B (#14). */
export interface EffectiveConfigurationViewModel {
  owner: ConfigurationOwner
  entries: EffectiveConfigurationEntry[]
}

export type RunReadinessBlockerCode =
  | 'provider-blocked'
  | 'agent-unavailable'
  | 'agent-archived'
  | 'model-unavailable'
  | 'project-archived'
  | 'project-root-unavailable'
  | 'project-repository-not-ready'

/** Deep link from a blocker to the single place that can clear it. */
export type RunReadinessBlockerTarget =
  | {
      kind: 'settings-section'
      section: ConfigurationSectionKey
      agentInstanceId?: AgentInstanceId
    }
  | { kind: 'provider-health' }

export interface RunReadinessBlocker {
  code: RunReadinessBlockerCode
  /** Chinese, user-facing. */
  message: string
  target?: RunReadinessBlockerTarget
}

/** Next-Run readiness summary for Settings C (#14). */
export interface RunReadinessViewModel {
  agentInstanceId: AgentInstanceId
  projectId: ProjectId
  status: 'ready' | 'blocked'
  blockers: RunReadinessBlocker[]
}

export interface QueueItemViewModel {
  queueItemId: QueueItemId
  projectId: ProjectId
  agentInstanceId: AgentInstanceId
  position: number
  priority: 'low' | 'normal' | 'high'
  /**
   * Exact link to the task Dispatch this queue item belongs to (#10). Only
   * task-linked queue entries carry it; cancelling the item cancels exactly
   * this Dispatch — never a sibling's.
   */
  dispatchId?: DispatchId
}

export interface PermissionRequestViewModel {
  requestId: PermissionRequestId
  projectId: ProjectId
  agentInstanceId: AgentInstanceId
  runId: RunId
  /** The concrete action awaiting approval, e.g. 写入文件. */
  action: string
  /** The effective scope the decision applies to, e.g. worktree 内 src/**. */
  scope: string
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
  kind: AttentionItemKind
  target: AttentionTarget
  state: 'open' | 'resolved'
  title: string
  /**
   * Exact link from a permission-requested item to its request. The item
   * resolves only when THIS request is decided — never via a broad
   * Run/Agent match, so concurrent requests keep their own reminders (#9).
   */
  permissionRequestId?: PermissionRequestId
}

export interface ConfirmationViewModel {
  confirmationId: ConfirmationId
  action: string
  target: string
  impact: string
  nonBypassableReason: string
}

// ---------------------------------------------------------------------------
// Tasks domain (#10) — local Project Task vs Feishu External Task projection
// ---------------------------------------------------------------------------

/** Stable reference to the task a Dispatch/Result belongs to. */
export type TaskRef =
  | { kind: 'project-task'; projectTaskId: ProjectTaskId }
  | { kind: 'external-task'; externalTaskId: ExternalTaskId }

/** Sync truth of an External Task projection, never inferred by the UI. */
export type TaskSyncState = 'synced' | 'offline' | 'conflict' | 'unavailable'

/** User review of an Execution Result — the only path to acceptance. */
export type ExecutionReviewState =
  | 'pending-review'
  | 'accepted'
  | 'revision-requested'

/** High-risk mock External Task operations routed through the confirmation host. */
export type ExternalTaskOperation =
  | 'delete'
  | 'batch-delete'
  | 'change-members'
  | 'change-permissions'

export interface DispatchViewModel {
  dispatchId: DispatchId
  projectId: ProjectId
  agentInstanceId: AgentInstanceId
  /** Immutable snapshot of the Agent's name at dispatch time (#10). */
  agentNameSnapshot: string
  taskRef: TaskRef
  instruction: string
  /**
   * Planner-bound lifecycle: a task dispatch starts ('active') or queues
   * ('queued') exactly as the confirmed plan projects; 'completed' only
   * ever comes from the explicit mock completion transition that also
   * produces the Execution Result; 'cancelled' means its queue item was
   * cancelled before it ever started — no result will follow.
   */
  status: 'active' | 'queued' | 'completed' | 'cancelled'
  createdAt: number
}

export interface ExecutionResultViewModel {
  resultId: ExecutionResultId
  dispatchId: DispatchId
  projectId: ProjectId
  agentInstanceId: AgentInstanceId
  taskRef: TaskRef
  summary: string
  reviewState: ExecutionReviewState
  createdAt: number
  reviewedAt?: number
}

/** A bounded local goal that only exists inside Agent Squad HQ. */
export interface ProjectTaskViewModel {
  projectTaskId: ProjectTaskId
  projectId: ProjectId
  title: string
  status: 'open' | 'completed'
  dispatchIds: DispatchId[]
}

/**
 * The local projection of a Feishu-held task. Feishu owns the business
 * fields; Agent Squad HQ tracks dispatch, results, acceptance and the
 * projection's version/sync truth. A single Run or accepted result never
 * changes `businessStatus` — that requires an explicit separate write.
 */
export interface ExternalTaskViewModel {
  externalTaskId: ExternalTaskId
  projectId: ProjectId
  title: string
  externalId: string
  version: number
  syncState: TaskSyncState
  businessStatus: 'open' | 'completed'
  /**
   * External deletion is a tombstone: the projection stays so local
   * Dispatch/Result audit and Attention deep links remain reachable (#10).
   */
  lifecycle: 'active' | 'deleted'
  dispatchIds: DispatchId[]
  /** A failed external write keeps the proposal and its reason (Issue #10). */
  proposedChange?: {
    summary: string
    failureReason: string
    /**
     * What the failed write actually intended, so a later explicit
     * conflict overwrite applies the REAL proposal instead of assuming a
     * business completion (#10 review).
     */
    action: 'complete' | ExternalTaskOperation
  }
}

export type ActivityKind =
  | 'run-started'
  | 'run-completed'
  | 'run-failed'
  | 'run-interrupted'
  | 'run-cancelled'
  | 'configuration-applied'
  | 'permission-decided'
  | 'attention-resolved'
  | 'instruction-sent'
  | 'dispatch-created'
  | 'execution-result-reviewed'
  | 'external-task-write'
  | 'external-task-write-failed'
  | 'external-task-conflict-resolved'
  | 'queue-cancelled'
  | 'dangerous-action-confirmed'

interface ActivityEntryBase {
  activityId: ActivityId
  timestamp: number
  summary: string
}

export type ActivityEntry =
  | (ActivityEntryBase & {
      kind: 'queue-cancelled'
      projectId: ProjectId
      agentInstanceId: AgentInstanceId
      queueItemId: QueueItemId
      reason: 'user-cancelled'
    })
  | (ActivityEntryBase & {
      kind: Exclude<ActivityKind, 'queue-cancelled'>
      projectId?: ProjectId
      agentInstanceId?: AgentInstanceId
      queueItemId?: never
      reason?: never
    })

// ---------------------------------------------------------------------------
// Chat entries (#67) — adapter-owned conversation facts per Agent Instance
// ---------------------------------------------------------------------------

/**
 * One visible entry in an Agent's Chat log (#67). Phase 1 seeds these from
 * the scenario; a real adapter projects them from Run events. `tool`
 * entries render as mono chips — `pending` while the tool is in flight.
 * The renderer never infers conversation content from runtime state.
 */
interface ChatEntryBase {
  entryId: ChatEntryId
  projectId: ProjectId
  agentInstanceId: AgentInstanceId
  text: string
}

export type ChatEntryViewModel =
  | (ChatEntryBase & {
      kind: 'user' | 'assistant'
      pending?: never
    })
  | (ChatEntryBase & {
      kind: 'tool'
      /** Still running vs settled. */
      pending?: boolean
    })

// ---------------------------------------------------------------------------
// Handoff (#12)
// ---------------------------------------------------------------------------

export interface HandoffArtifactViewModel {
  path: string
  status: 'included' | 'missing'
}

export interface HandoffValidationViewModel {
  status: 'pass' | 'fail' | 'pending'
  message?: string
}

export type HandoffImportState =
  | 'not-imported'
  | 'inspect-only'
  | 'execute-confirmed'

export interface HandoffViewModel {
  handoffId: HandoffId
  projectId: ProjectId
  source: {
    agentInstanceId: AgentInstanceId
    agentName: string
  }
  target?: {
    agentInstanceId: AgentInstanceId
    agentName: string
  }
  provenance: {
    origin: 'local' | 'imported' | 'cross-project' | 'quit-snapshot'
    createdAt: number
    /** Project name for cross-project provenance only. */
    sourceProjectName?: string
  }
  goal: string
  summary: string
  baseCommit: string
  changeSummary: string
  artifacts: HandoffArtifactViewModel[]
  validation: HandoffValidationViewModel
  completeness: 'complete' | 'incomplete'
  incompleteReason?: string
  recoveryActions: string[]
  importState: HandoffImportState
}

// ---------------------------------------------------------------------------
// Quit preview (#12)
// ---------------------------------------------------------------------------

export type HandoffDirtyReason =
  | 'successful-round'
  | 'worktree-changes'
  | 'active-run'
  | 'active-terminal'
  | 'failed-run'
  | 'interrupted-run'
  | 'pending-confirmation'
  | 'unsynced-task'
  | 'manual'

export interface QuitPreviewViewModel {
  phase: 'resolve-active-work' | 'request-final-handoff'
  activeRuns: Array<{
    projectId: ProjectId
    agentInstanceId: AgentInstanceId
    agentName: string
    runId: RunId
    runtimeState: AgentRuntimeState
  }>
  activeTerminals: Array<{
    projectId: ProjectId
    agentInstanceId: AgentInstanceId
    agentName: string
  }>
  handoffDirtyAgents: Array<{
    projectId: ProjectId
    agentInstanceId: AgentInstanceId
    agentName: string
    changeSummary: string
    reasons: HandoffDirtyReason[]
  }>
}

export interface WorktreeChangesViewModel {
  agentInstanceId: AgentInstanceId
  baseCommit: string
  drift: 'none' | 'behind'
  files: Array<{
    path: string
    status: 'modified' | 'added' | 'deleted'
    additions: number
    deletions: number
  }>
  validation: {
    status: 'pass' | 'fail' | 'pending'
    message?: string
  }
}

export interface WorkbenchViewModel {
  schemaVersion: 1
  revision: number
  activeProjectId?: ProjectId
  activeGlobalSurface?: GlobalSurface
  projects: ProjectViewModel[]
  knowledge: KnowledgeContainerViewModel[]
  agents: AgentInstanceViewModel[]
  queue: QueueItemViewModel[]
  permissionRequests: PermissionRequestViewModel[]
  attentionItems: AttentionItemViewModel[]
  projectTasks: ProjectTaskViewModel[]
  externalTasks: ExternalTaskViewModel[]
  dispatches: DispatchViewModel[]
  executionResults: ExecutionResultViewModel[]
  pendingConfirmation?: ConfirmationViewModel
  configurationDrafts: ConfigurationDraftViewModel[]
  appliedConfigurations: AppliedConfigurationViewModel[]
  /**
   * Adapter-computed applied/effective truth per owner (#14 Settings B).
   * Derived facts, recomputed on every emitted revision — never
   * renderer-derived, never independently mutable truth.
   */
  effectiveConfigurations: EffectiveConfigurationViewModel[]
  /**
   * Adapter-computed next-Run readiness per Agent (#14 Settings C). Derived
   * facts, recomputed on every emitted revision; blockers link back to the
   * single edit location that can clear them.
   */
  runReadiness: RunReadinessViewModel[]
  changes: WorktreeChangesViewModel[]
  activity: ActivityEntry[]
  /** Chat log entries per Agent Instance (#67), oldest first. */
  chatEntries: ChatEntryViewModel[]
  handoffs: HandoffViewModel[]
  quitPreview?: QuitPreviewViewModel
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
    providers: Array<{
      providerId: AgentProviderId
      displayName: string
      status: 'ready' | 'blocked'
      models: Array<{ modelId: string; displayName: string }>
    }>
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
  | {
      kind: 'move-tab'
      agentInstanceId: AgentInstanceId
      targetPanelId: PanelId
      /**
       * Insertion position within the target panel's tab strip (#77). When
       * omitted the tab lands at the end (existing behaviour); when present
       * the tab is inserted at that index — enabling pointer drag-and-drop
       * reordering within and across panels.
       */
      insertionIndex?: number
    }
  | {
      kind: 'open-tab-in-new-panel'
      agentInstanceId: AgentInstanceId
      direction: 'horizontal' | 'vertical'
      position?: 'before' | 'after'
      relativeToPanelId?: PanelId
    }
  | { kind: 'close-panel'; panelId: PanelId; migrateToPanelId?: PanelId }
  | {
      kind: 'split-panel'
      panelId: PanelId
      direction: 'horizontal' | 'vertical'
    }
  | { kind: 'resize-split'; splitNodeId: SplitNodeId; ratio: number }
  | { kind: 'focus-panel'; panelId?: PanelId }
  | { kind: 'apply-analysis-preset'; panelId: PanelId }
  | { kind: 'prune-empty-panels' }

/**
 * Authoritative Agent-target consequence of an accepted layout command.
 *
 * The shared reducer emits this alongside its next layout so renderer
 * consumers never have to duplicate structural transition rules merely to
 * learn which Agent a close/move/migration selected.
 */
export type LayoutTargetEffect =
  | {
      kind: 'selected-agent'
      agentInstanceId: AgentInstanceId | null
    }
  | {
      kind: 'closed-agent'
      agentInstanceId: AgentInstanceId
      selectedAgentInstanceId?: AgentInstanceId | null
    }

/**
 * Whether an operation can produce a LayoutTargetEffect. This contract-level
 * classifier lets consumers order only target-relevant pending commands;
 * structural commands must never block an already accepted target effect.
 */
export function layoutOperationMayProduceTargetEffect(
  operation: LayoutOperation
): boolean {
  return 'agentInstanceId' in operation || operation.kind === 'close-panel'
}

export type WorkbenchCommandBody =
  | { kind: 'navigate-global'; surface: GlobalSurface }
  | { kind: 'navigate'; projectId: ProjectId; surface: ProjectSurface }
  | {
      /**
       * Create a Project from the home page's quick-create area (#76) and
       * land directly inside it. Demo boundary: the root path arrives as
       * text; real directory picking (`dialog.showOpenDialog`) and the
       * durable ProjectStore are Phase 2.
       */
      kind: 'create-project'
      name: string
      rootPath: string
    }
  | {
      kind: 'preview-knowledge-security-event'
      projectId: ProjectId
      knowledgeResourceId: KnowledgeResourceId
      action: KnowledgeSecurityAction
    }
  | {
      kind: 'recover-knowledge-connection'
      projectId: ProjectId
      knowledgeResourceId: KnowledgeResourceId
    }
  | { kind: 'change-layout'; projectId: ProjectId; operation: LayoutOperation }
  | {
      kind: 'create-agent'
      projectId: ProjectId
      name: string
      providerId: AgentProviderId
      modelId: string
      open: AgentOpenMode
      worktreeMode: AgentWorktreeMode
    }
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
      kind: 'dispatch-task'
      projectId: ProjectId
      taskRef: TaskRef
      targets: AgentInstanceId[]
      instruction: string
    }
  | {
      kind: 'complete-dispatch'
      projectId: ProjectId
      dispatchId: DispatchId
    }
  | {
      kind: 'review-execution-result'
      projectId: ProjectId
      resultId: ExecutionResultId
      decision: 'accept' | 'request-revision'
    }
  | {
      kind: 'update-external-task-status'
      projectId: ProjectId
      externalTaskId: ExternalTaskId
      status: 'completed'
      expectedVersion: number
    }
  | {
      kind: 'resolve-external-task-conflict'
      projectId: ProjectId
      externalTaskId: ExternalTaskId
      expectedVersion: number
      resolution: 'discard' | 'overwrite'
    }
  | {
      kind: 'request-external-task-operation'
      projectId: ProjectId
      operation: ExternalTaskOperation
      externalTaskIds: ExternalTaskId[]
    }
  | {
      kind: 'apply-external-task-update'
      projectId: ProjectId
      externalTaskId: ExternalTaskId
      version: number
      summary: string
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
      mode: 'request-execute'
    }
  | {
      kind: 'import-handoff'
      projectId: ProjectId
      handoffId: HandoffId
      targetAgentInstanceId: AgentInstanceId
      mode: 'execute-confirmed'
      confirmationId: ConfirmationId
    }
  | { kind: 'request-connection-deletion'; connectionId: ConnectionId }
  | { kind: 'request-provider-recovery'; providerId: AgentProviderId }
  | { kind: 'dismiss-confirmation' }
  | { kind: 'merge-agent-changes'; agentInstanceId: AgentInstanceId }
  | { kind: 'discard-agent-changes'; agentInstanceId: AgentInstanceId }
  | { kind: 'request-quit-preview' }
  | {
      kind: 'execute-quit'
      action: 'wait-for-runs' | 'stop-runs' | 'request-final-handoff' | 'force-quit'
    }
  | { kind: 'confirm-dangerous-action'; confirmationId: ConfirmationId }
  | {
      /**
       * Archive (= close) an Agent instance (#78). The adapter interrupts
       * any active Run, clears queue items, suppresses Attention, and
       * preserves the transcript for read-only viewing. Requires confirmation
       * when the instance is running, queued, or has pending Attention.
       */
      kind: 'archive-instance'
      projectId: ProjectId
      agentInstanceId: AgentInstanceId
    }
  | {
      /**
       * Reopen a previously archived Agent instance (#78). Restores the
       * instance to 'ready' while keeping the historical transcript visible.
       */
      kind: 'restore-instance'
      projectId: ProjectId
      agentInstanceId: AgentInstanceId
    }

/** Commands whose successful result may carry a LayoutTargetEffect. */
export function commandMayProduceLayoutTargetEffect(
  command: WorkbenchCommandBody
): boolean {
  if (command.kind === 'change-layout') {
    return layoutOperationMayProduceTargetEffect(command.operation)
  }
  return command.kind === 'create-agent' && command.open !== 'background'
}

export type WorkbenchCommand = CommandMeta & WorkbenchCommandBody

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
  | {
      ok: true
      commandId: CommandId
      acceptedRevision: number
      layoutTargetEffect?: LayoutTargetEffect
    }
  | {
      ok: false
      commandId: CommandId
      reason: CommandRejectionReason
      latestRevision: number
      message: string
    }

export type DispatchPlanEntry =
  | {
      readonly agentInstanceId: AgentInstanceId
      readonly outcome: 'start'
    }
  | {
      readonly agentInstanceId: AgentInstanceId
      readonly outcome: 'queue'
      readonly position: number
    }

export interface DispatchPlan {
  readonly revision: number
  readonly projectId: ProjectId
  readonly entries: readonly DispatchPlanEntry[]
}

export interface DispatchPlanRequest {
  readonly expectedRevision: number
  readonly projectId: ProjectId
  readonly targets: readonly AgentInstanceId[]
}

export type DispatchPlanResult =
  | { readonly ok: true; readonly plan: DispatchPlan }
  | {
      readonly ok: false
      readonly reason: CommandRejectionReason
      readonly latestRevision: number
      readonly message: string
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
  planDispatch(request: DispatchPlanRequest): Promise<DispatchPlanResult>
  dispatch(command: WorkbenchCommand): Promise<CommandResult>
  subscribe(listener: (event: WorkbenchEvent) => void): () => void
}
