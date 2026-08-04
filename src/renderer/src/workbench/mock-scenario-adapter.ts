import type {
  AgentInstanceId,
  Brand,
  CommandId,
  CommandRejectionReason,
  CommandResult,
  ConfirmationId,
  ConnectionId,
  DispatchPlanRequest,
  DispatchPlanResult,
  HandoffId,
  LayoutTargetEffect,
  QuitPreviewViewModel,
  PanelId,
  PermissionRequestId,
  ProjectId,
  WorkbenchCommand,
  WorkbenchEvent,
  WorkbenchPort,
  WorkbenchViewModel
} from './contract'
import { id } from './contract'
import {
  applyLayoutOperation,
  type LayoutIdGenerator
} from './layout-reducer'
import { createStandardScenario } from './standard-scenario'
import { validateAgentName } from './agent-name'
import {
  fieldDescriptor,
  fieldPathsFor,
  formatResourceScope,
  normalizeAppliedValue,
  ownerKey,
  parseResourceScope,
  sameOwner,
  validateConfigurationValue
} from './configuration'
import type { ConfigurationOwner } from './contract'
import type { ProjectDispatchBlockReason } from './dispatchability'
import {
  getProjectDispatchBlockReason,
  isActiveStructuredRunState,
  isAgentBusy,
  isTerminalExecutionSlotOccupied
} from './dispatchability'
import { resolveProviderModelSelection } from './provider-capability'
import { buildDispatchPlan } from './dispatch-planner'
import { stepQueuePriority } from './queue-priority'

function projectExecutionUnavailableMessage(
  reason: ProjectDispatchBlockReason,
  action: '发送新指令' | '创建新派发' | '接管 Terminal'
): string {
  switch (reason) {
    case 'project-archived':
      return `Project 已归档，不能${action}`
    case 'project-root-unavailable':
      return `Project Root 不可用，不能${action}`
    case 'project-repository-not-ready':
      return `Project 尚未初始化或绑定 Git 仓库，不能${action}`
  }
}

type PostDispatchEvent =
  | Omit<Extract<WorkbenchEvent, { kind: 'dispatch-created' }>, 'revision'>
  | Omit<
      Extract<WorkbenchEvent, { kind: 'configuration-applied' }>,
      'revision'
    >
  | Omit<Extract<WorkbenchEvent, { kind: 'attention-changed' }>, 'revision'>
  | Omit<Extract<WorkbenchEvent, { kind: 'handoff-imported' }>, 'revision'>

type AcceptedCommandMetadata = {
  layoutTargetEffect?: LayoutTargetEffect
}

type ConfigurationDraftEntry =
  WorkbenchViewModel['configurationDrafts'][number]
type AppliedConfigurationEntry =
  WorkbenchViewModel['appliedConfigurations'][number]

type ConfigurationApplyPlan = {
  batchProjectId: ProjectId
  ownerKeys: string[]
  commits: Array<{
    owner: ConfigurationOwner
    values: Record<string, unknown>
    appliedVersion: number
  }>
  integration?: {
    nextPrimary?: ConnectionId
    nextBindings: WorkbenchViewModel['projects'][number]['resourceBindings']
    removedBindings: WorkbenchViewModel['projects'][number]['resourceBindings']
  }
}

function sameConfigurationValue(
  current: unknown,
  previewed: unknown,
  seen = new WeakMap<object, object>()
): boolean {
  if (Object.is(current, previewed)) return true
  if (
    current === null ||
    previewed === null ||
    typeof current !== 'object' ||
    typeof previewed !== 'object'
  ) {
    return false
  }
  const seenPreview = seen.get(current)
  if (seenPreview) return seenPreview === previewed
  seen.set(current, previewed)

  if (Array.isArray(current) || Array.isArray(previewed)) {
    return (
      Array.isArray(current) &&
      Array.isArray(previewed) &&
      current.length === previewed.length &&
      current.every((value, index) =>
        sameConfigurationValue(value, previewed[index], seen)
      )
    )
  }
  if (current instanceof Date || previewed instanceof Date) {
    return (
      current instanceof Date &&
      previewed instanceof Date &&
      current.getTime() === previewed.getTime()
    )
  }
  // Configuration values are scalar or JSON-shaped. Unsupported structured
  // objects fail closed instead of making a stale preview appear equal.
  if (
    Object.getPrototypeOf(current) !== Object.prototype ||
    Object.getPrototypeOf(previewed) !== Object.prototype
  ) {
    return false
  }
  const currentKeys = Object.keys(current)
  const previewedKeys = Object.keys(previewed)
  return (
    currentKeys.length === previewedKeys.length &&
    currentKeys.every(
      (key) =>
        Object.hasOwn(previewed, key) &&
        sameConfigurationValue(
          (current as Record<string, unknown>)[key],
          (previewed as Record<string, unknown>)[key],
          seen
        )
    )
  )
}

function sameConfigurationDraft(
  current: ConfigurationDraftEntry | undefined,
  previewed: ConfigurationDraftEntry
): boolean {
  if (
    !current ||
    ownerKey(current.owner) !== ownerKey(previewed.owner) ||
    current.appliedVersion !== previewed.appliedVersion ||
    current.changes.length !== previewed.changes.length ||
    current.validationErrors.length !== previewed.validationErrors.length
  ) {
    return false
  }
  return (
    current.changes.every((change, index) => {
      const expected = previewed.changes[index]
      return (
        change.fieldPath === expected.fieldPath &&
        sameConfigurationValue(change.applied, expected.applied) &&
        sameConfigurationValue(change.draft, expected.draft)
      )
    }) &&
    current.validationErrors.every((error, index) => {
      const expected = previewed.validationErrors[index]
      return (
        error.fieldPath === expected.fieldPath &&
        error.message === expected.message
      )
    })
  )
}

function formatConfirmationValue(value: unknown): string {
  if (value === null) return '无'
  if (value === '') return '空'
  return String(value)
}

/**
 * In-memory WorkbenchPort backed by a deterministic scenario snapshot.
 *
 * Phase 1 uses this adapter to drive the full renderer without any real
 * Agent, PTY, Git, Feishu or persistence side effects. Future real adapters
 * (main/preload) must satisfy the same contract suite.
 *
 * Deadlines and audit timestamps share one injected time source (default
 * `Date.now`): scenario data, the construction sweep and the permission
 * timers always observe the same clock, so a frozen-clock scenario stays
 * deterministic and never mixes in the process wall clock (#9).
 */
export class MockScenarioAdapter implements WorkbenchPort {
  private snapshot: WorkbenchViewModel
  private readonly clock: () => number
  private listeners = new Set<(event: WorkbenchEvent) => void>()
  private resultsByCommandId = new Map<CommandId, CommandResult>()
  private eventQueue: WorkbenchEvent[] = []
  private emittingEvents = false
  private createdAgentCount = 0
  private createdPanelCount = 0
  private createdSplitCount = 0
  /** Scheduled default-deny transitions for pending permission requests (#9). */
  private permissionTimers = new Map<
    PermissionRequestId,
    ReturnType<typeof setTimeout>
  >()
  /**
   * ID supply for the shared layout reducer. IDs stay opaque and
   * deterministic per adapter instance (`panel-created-N` /
   * `split-created-N`), never derived from visible names.
   */
  private readonly layoutIds: LayoutIdGenerator = {
    newPanelId: () =>
      id(`panel-created-${++this.createdPanelCount}`, 'PanelId'),
    newSplitNodeId: () =>
      id(`split-created-${++this.createdSplitCount}`, 'SplitNodeId')
  }
  private pendingAction:
    | {
        type: 'connection-deletion'
        connectionId: ConnectionId
        affectedProjectIds: ProjectId[]
        fingerprint: string
      }
    | { type: 'merge-changes'; agentInstanceId: AgentInstanceId }
    | { type: 'discard-changes'; agentInstanceId: AgentInstanceId }
    | {
        type: 'configuration-apply'
        plan: ConfigurationApplyPlan
        fingerprint: string
      }
    | {
        type: 'discard-configuration'
        projectId: ProjectId
        drafts: ConfigurationDraftEntry[]
      }
    | {
        type: 'handoff-execute'
        projectId: ProjectId
        handoffId: HandoffId
        targetAgentInstanceId: AgentInstanceId
      }
    | null = null

  constructor(
    snapshot: WorkbenchViewModel = createStandardScenario(),
    options: { now?: () => number } = {}
  ) {
    this.clock = options.now ?? Date.now
    this.snapshot = structuredClone(snapshot)
    // Agent runtime states are authoritative. Scenario summary fields are
    // projections and may arrive stale, so repair them before exposing or
    // scheduling against the snapshot (#39).
    this.recomputeActiveRunCounts()
    // Attention counts are projections of the authoritative item list (#9).
    this.recomputeAttentionCounts()
    // Requests already past their deadline are published as denied before
    // the first snapshot ever leaves the adapter — they never surface as
    // pending, and the default-deny transition is audited from the start.
    for (const request of [...this.snapshot.permissionRequests]) {
      if (this.clock() >= request.expiresAt) {
        this.expirePermissionRequest(request, [])
      }
    }
    this.schedulePermissionTimers()
  }

  async getSnapshot(): Promise<WorkbenchViewModel> {
    return structuredClone(this.snapshot)
  }

  async planDispatch(
    request: DispatchPlanRequest
  ): Promise<DispatchPlanResult> {
    return structuredClone(buildDispatchPlan(this.snapshot, request))
  }

  async dispatch(command: WorkbenchCommand): Promise<CommandResult> {
    // 1. Idempotency — duplicate commandId returns the cached result.
    const cached = this.resultsByCommandId.get(command.commandId)
    if (cached) return cached

    // 2. Optimistic concurrency — expectedRevision must match.
    if (command.expectedRevision !== this.snapshot.revision) {
      return this.reject(command, 'stale-revision', 'revision 已过期')
    }

    // 3. Command-specific handling — returns a rejection or null (success).
    //    Follow-up events belong to this dispatch invocation. Keeping them
    //    local prevents a reentrant subscriber command from replacing them.
    const postEvents: PostDispatchEvent[] = []
    const acceptedMetadata: AcceptedCommandMetadata = {}
    const rejection = this.tryApply(command, postEvents, acceptedMetadata)
    if (rejection) return rejection

    // 4. Success — bump revision, cache and emit the complete event batch.
    const acceptedRevision = ++this.snapshot.revision
    const result: CommandResult = {
      ok: true,
      commandId: command.commandId,
      acceptedRevision,
      ...acceptedMetadata
    }
    this.resultsByCommandId.set(command.commandId, result)
    const events: WorkbenchEvent[] = [
      {
        kind: 'view-model-updated',
        revision: acceptedRevision,
        correlationId: command.commandId,
        snapshot: structuredClone(this.snapshot)
      },
      ...postEvents.map((partial) => ({
        ...partial,
        revision: acceptedRevision
      }))
    ]
    // Queue the whole batch before notifying subscribers. A subscriber may
    // dispatch reentrantly; its newer-revision events must follow every event
    // belonging to this accepted revision.
    this.emit(...events)
    return result
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // -- internals ---------------------------------------------------------

  /**
   * Applies a command to the internal snapshot.
   * Returns a rejection result for invalid targets or unimplemented commands,
   * or null to signal success (caller bumps revision and emits).
   */
  private tryApply(
    command: WorkbenchCommand,
    postEvents: PostDispatchEvent[],
    acceptedMetadata: AcceptedCommandMetadata
  ): CommandResult | null {
    switch (command.kind) {
      case 'navigate': {
        const project = this.snapshot.projects.find(
          (p) => p.projectId === command.projectId
        )
        if (!project) {
          return this.reject(command, 'invalid-target', 'Project 不存在')
        }
        project.currentSurface = command.surface
        this.snapshot.activeProjectId = command.projectId
        this.snapshot.activeGlobalSurface = undefined
        return null
      }
      case 'navigate-global': {
        this.snapshot.activeGlobalSurface = command.surface
        return null
      }
      case 'create-agent': {
        const project = this.snapshot.projects.find(
          (p) => p.projectId === command.projectId
        )
        if (!project) {
          return this.reject(command, 'invalid-target', 'Project 不存在')
        }
        const selection = resolveProviderModelSelection(
          this.snapshot.global.providers,
          command.providerId,
          command.modelId
        )
        if (!selection.ok) {
          return this.reject(
            command,
            selection.code === 'provider-unavailable'
              ? 'unavailable'
              : 'invalid-target',
            selection.message
          )
        }
        const { provider } = selection
        const nameCheck = validateAgentName(command.name)
        if (!nameCheck.ok) {
          return this.reject(command, 'invalid-target', nameCheck.reason!)
        }
        const name = command.name.trim()
        const nameTaken = this.snapshot.agents.some(
          (a) =>
            a.projectId === project.projectId &&
            a.name.toLowerCase() === name.toLowerCase()
        )
        if (nameTaken) {
          return this.reject(
            command,
            'invariant-violation',
            `Agent 名称 "${name}" 已存在`
          )
        }

        // Opaque, stable instance ID — never derived from the visible name.
        this.createdAgentCount++
        const agentInstanceId = id(
          `inst-created-${this.createdAgentCount}`,
          'AgentInstanceId'
        )
        this.snapshot.agents.push({
          agentInstanceId,
          projectId: project.projectId,
          name,
          providerId: provider.providerId,
          runtimeState: 'ready',
          terminalState: 'closed',
          worktreeMode: command.worktreeMode,
          queueDepth: 0,
          doctor: 'ready',
          lastActivityAt: this.clock()
        })
        // Every configurable owner needs its applied truth (#13). The
        // command carries the user's confirmed creation draft, initially
        // seeded from the Project's applied defaults by the renderer.
        this.snapshot.appliedConfigurations.push({
          owner: { kind: 'agent', agentInstanceId },
          appliedVersion: 1,
          values: {
            'identity.name': name,
            'model.id': command.modelId,
            'proxy.http': '',
            'env.custom': '',
            'concurrency.priority': 'normal',
            'budget.maxTokens': 200000
          }
        })
        // Creation never produces a Run; opening only changes the layout,
        // through the same shared reducer as any other layout command.
        const acceptCreatedAgentLayout = (
          result: ReturnType<typeof applyLayoutOperation>
        ): void => {
          if (!result.ok) return
          project.layout = result.layout
          if (result.targetEffect) {
            acceptedMetadata.layoutTargetEffect = result.targetEffect
          }
        }
        if (command.open === 'current-panel') {
          // The reducer allocates the first panel when the workspace is
          // empty, so the placeholder panelId is never dereferenced then.
          const targetPanelId =
            project.layout.focusedPanelId ??
            (Object.keys(project.layout.panels)[0] as PanelId | undefined) ??
            id('panel-auto', 'PanelId')
          acceptCreatedAgentLayout(
            applyLayoutOperation(
              project.layout,
              { kind: 'open-tab', panelId: targetPanelId, agentInstanceId },
              this.layoutIds
            )
          )
        } else if (command.open === 'new-panel') {
          acceptCreatedAgentLayout(
            applyLayoutOperation(
              project.layout,
              {
                kind: 'open-tab-in-new-panel',
                agentInstanceId,
                direction: 'horizontal'
              },
              this.layoutIds
            )
          )
        }
        return null
      }
      case 'request-connection-deletion': {
        const busy = this.rejectIfConfirmationPending(command)
        if (busy) return busy
        const conn = this.snapshot.global.connections.find(
          (c) => c.connectionId === command.connectionId
        )
        if (!conn) {
          return this.reject(command, 'invalid-target', '连接不存在')
        }
        const affectedProjectIds =
          this.connectionDeletionProjectIds(command.connectionId)
        const affected = new Set(affectedProjectIds)
        const affectedProjects = this.snapshot.projects.filter((project) =>
          affected.has(project.projectId)
        )
        this.pendingAction = {
          type: 'connection-deletion',
          connectionId: command.connectionId,
          affectedProjectIds,
          fingerprint: this.connectionDeletionFingerprint(
            command.connectionId,
            affectedProjectIds
          )
        }
        let impact = `此操作将永久删除「${conn.label}」，且不可恢复。`
        if (affectedProjects.length > 0) {
          impact += `以下 Project 将解除主连接或资源引用：${affectedProjects.map((project) => project.name).join('、')}。`
          const removedLabels = affectedProjects.flatMap((project) =>
            project.resourceBindings
              .filter(
                (binding) => binding.connectionId === command.connectionId
              )
              .map((binding) => binding.label)
          )
          if (removedLabels.length > 0) {
            impact += `同时解除 Resource Binding：${removedLabels.join('、')}。`
          }
        }
        this.snapshot.pendingConfirmation = {
          confirmationId: id(crypto.randomUUID(), 'ConfirmationId'),
          action: '删除连接',
          target: conn.label,
          impact,
          nonBypassableReason: '高风险操作需要二次确认，无法跳过'
        }
        return null
      }
      case 'request-provider-recovery': {
        const provider = this.snapshot.global.providers.find(
          (p) => p.providerId === command.providerId
        )
        if (!provider) {
          return this.reject(command, 'invalid-target', 'Provider 不存在')
        }
        provider.status = 'ready'
        return null
      }
      case 'merge-agent-changes': {
        const busy = this.rejectIfConfirmationPending(command)
        if (busy) return busy
        const changes = this.snapshot.changes.find(
          (c) => c.agentInstanceId === command.agentInstanceId
        )
        if (!changes) {
          return this.reject(command, 'invalid-target', '找不到该 Agent 的改动')
        }
        if (changes.drift === 'behind') {
          return this.reject(
            command,
            'unavailable',
            '需要 rebase：base commit 已落后，请先更新 worktree'
          )
        }
        if (changes.validation.status === 'fail') {
          return this.reject(
            command,
            'unavailable',
            `验证未通过：${changes.validation.message ?? ''}`
          )
        }
        const agent = this.snapshot.agents.find(
          (a) => a.agentInstanceId === command.agentInstanceId
        )
        this.pendingAction = {
          type: 'merge-changes',
          agentInstanceId: command.agentInstanceId
        }
        this.snapshot.pendingConfirmation = {
          confirmationId: id(crypto.randomUUID(), 'ConfirmationId'),
          action: 'ff-only 合并',
          target: agent?.name ?? command.agentInstanceId,
          impact: `将以快进方式合并 ${changes.files.length} 个文件改动到主仓库。`,
          nonBypassableReason: '合并前需二次确认，确保主仓库干净'
        }
        return null
      }
      case 'discard-agent-changes': {
        const busy = this.rejectIfConfirmationPending(command)
        if (busy) return busy
        const changes = this.snapshot.changes.find(
          (c) => c.agentInstanceId === command.agentInstanceId
        )
        if (!changes) {
          return this.reject(command, 'invalid-target', '找不到该 Agent 的改动')
        }
        const agent = this.snapshot.agents.find(
          (a) => a.agentInstanceId === command.agentInstanceId
        )
        this.pendingAction = {
          type: 'discard-changes',
          agentInstanceId: command.agentInstanceId
        }
        this.snapshot.pendingConfirmation = {
          confirmationId: id(crypto.randomUUID(), 'ConfirmationId'),
          action: '丢弃改动',
          target: agent?.name ?? command.agentInstanceId,
          impact: `将永久丢弃 ${changes.files.length} 个文件的改动，不可恢复。`,
          nonBypassableReason: '高风险操作需要二次确认，无法跳过'
        }
        return null
      }
      case 'confirm-dangerous-action': {
        const pending = this.snapshot.pendingConfirmation
        if (!pending || pending.confirmationId !== command.confirmationId) {
          return this.reject(
            command,
            'invalid-target',
            '无效或过期的确认 ID'
          )
        }
        const pendingAction = this.pendingAction
        if (!pendingAction) {
          return this.reject(command, 'invalid-target', '确认操作已过期')
        }
        if (
          pendingAction.type === 'discard-configuration' &&
          pendingAction.drafts.some((previewed) => {
            const current = this.snapshot.configurationDrafts.find(
              (draft) => ownerKey(draft.owner) === ownerKey(previewed.owner)
            )
            return !sameConfigurationDraft(current, previewed)
          })
        ) {
          return this.reject(
            command,
            'invalid-target',
            '确认已过期：配置草稿已变化，请重新预览'
          )
        }
        const { action, target } = pending

        if (pendingAction.type === 'configuration-apply') {
          const frozen = pendingAction
          const currentFingerprint = this.configurationApplyFingerprint(
            frozen.plan.batchProjectId,
            frozen.plan.ownerKeys
          )
          if (currentFingerprint !== frozen.fingerprint) {
            return this.reject(
              command,
              'invalid-target',
              '集成变更预览已过期；配置或绑定已变化，请重新应用'
            )
          }
          if (
            !this.commitConfigurationApply(
              frozen.plan,
              postEvents,
              command.commandId
            )
          ) {
            return this.reject(
              command,
              'invalid-target',
              '集成变更无法原子提交，请重新应用'
            )
          }
          this.snapshot.pendingConfirmation = undefined
          this.pendingAction = null
          this.snapshot.activity.unshift({
            activityId: this.freshId('ActivityId'),
            projectId: frozen.plan.batchProjectId,
            timestamp: this.clock(),
            kind: 'dangerous-action-confirmed',
            summary: `已确认: ${action}（${target}）`
          })
          return null
        }

        if (pendingAction.type === 'connection-deletion') {
          const deletion = pendingAction
          const currentFingerprint = this.connectionDeletionFingerprint(
            deletion.connectionId,
            deletion.affectedProjectIds
          )
          if (currentFingerprint !== deletion.fingerprint) {
            return this.reject(
              command,
              'invalid-target',
              '连接删除预览已过期；引用或配置草稿已变化，请重新发起'
            )
          }
        }

        let activityProjectId: ProjectId | undefined
        let activityAgentInstanceId: AgentInstanceId | undefined

        // Execute the pending mock action.
        if (pendingAction.type === 'connection-deletion') {
          const deletion = pendingAction
          const connId = deletion.connectionId
          const affected = new Set(deletion.affectedProjectIds)
          this.snapshot.global.connections =
            this.snapshot.global.connections.filter(
              (c) => c.connectionId !== connId
            )
          for (const proj of this.snapshot.projects) {
            if (!affected.has(proj.projectId)) continue
            if (proj.primaryConnectionId === connId) {
              proj.primaryConnectionId = undefined
            }
            // Bindings of the deleted connection die with it.
            proj.resourceBindings = proj.resourceBindings.filter(
              (b) => b.connectionId !== connId
            )
          }
          // Synchronise applied configuration truth in the same
          // transition: a stale ConnectionId must never be resurrected
          // by a later configuration apply. The version bump also
          // stale-rejects drafts based on the old truth.
          for (const config of this.snapshot.appliedConfigurations) {
            if (config.owner.kind !== 'project') continue
            const ownerProjectId = config.owner.projectId
            if (!affected.has(ownerProjectId)) continue
            const project = this.snapshot.projects.find(
              (candidate) => candidate.projectId === ownerProjectId
            )
            if (!project) continue
            const primaryChanged =
              config.values['integrations.primaryConnectionId'] === connId
            const nextScope = formatResourceScope(project.resourceBindings)
            const scopeChanged =
              config.values['integrations.resourceScope'] !== nextScope
            if (primaryChanged) {
              config.values['integrations.primaryConnectionId'] = null
            }
            if (scopeChanged) {
              config.values['integrations.resourceScope'] = nextScope
            }
            if (primaryChanged || scopeChanged) {
              config.appliedVersion += 1
            }
          }
        } else if (pendingAction.type === 'discard-configuration') {
          const drop = new Set(
            pendingAction.drafts.map((draft) => ownerKey(draft.owner))
          )
          this.snapshot.configurationDrafts =
            this.snapshot.configurationDrafts.filter(
              (draft) => !drop.has(ownerKey(draft.owner))
            )
          activityProjectId = pendingAction.projectId
          if (
            pendingAction.drafts.length === 1 &&
            pendingAction.drafts[0].owner.kind === 'agent'
          ) {
            activityAgentInstanceId =
              pendingAction.drafts[0].owner.agentInstanceId
          }
        } else if (pendingAction.type === 'handoff-execute') {
          const handoff = this.snapshot.handoffs.find(
            (h) => h.handoffId === pendingAction.handoffId
          )!
          const agent = this.snapshot.agents.find(
            (a) =>
              a.agentInstanceId === pendingAction.targetAgentInstanceId
          )!
          this.commitHandoffExecute(
            handoff,
            agent,
            postEvents,
            command.commandId
          )
          // commitHandoffExecute already records activity and clears the
          // confirmation, so skip the generic post-confirm block below.
          return null
        } else {
          // merge-changes or discard-changes: both carry agentInstanceId
          const agentId = pendingAction.agentInstanceId
          this.snapshot.changes = this.snapshot.changes.filter(
            (c) => c.agentInstanceId !== agentId
          )
        }

        this.snapshot.pendingConfirmation = undefined
        this.pendingAction = null
        this.snapshot.activity.unshift({
          activityId: id(crypto.randomUUID(), 'ActivityId'),
          ...(activityProjectId ? { projectId: activityProjectId } : {}),
          ...(activityAgentInstanceId
            ? { agentInstanceId: activityAgentInstanceId }
            : {}),
          timestamp: this.clock(),
          kind: 'dangerous-action-confirmed',
          summary: `已确认: ${action}（${target}）`
        })
        return null
      }
      case 'dismiss-confirmation': {
        this.snapshot.pendingConfirmation = undefined
        this.pendingAction = null
        return null
      }
      case 'change-layout': {
        const project = this.snapshot.projects.find(
          (p) => p.projectId === command.projectId
        )
        if (!project) {
          return this.reject(command, 'invalid-target', 'Project 不存在')
        }
        // Agent references are validated up front — the reducer only sees
        // IDs — so a rejected command stays side-effect free.
        const { operation } = command
        if (
          'agentInstanceId' in operation &&
          !this.snapshot.agents.some(
            (a) =>
              a.agentInstanceId === operation.agentInstanceId &&
              a.projectId === project.projectId
          )
        ) {
          return this.reject(command, 'invalid-target', 'Agent 不存在')
        }
        const result = applyLayoutOperation(
          project.layout,
          operation,
          this.layoutIds
        )
        if (!result.ok) {
          return this.reject(command, result.reason, result.message)
        }
        project.layout = result.layout
        if (result.targetEffect) {
          acceptedMetadata.layoutTargetEffect = result.targetEffect
        }
        return null
      }
      case 'send-agent-instruction': {
        const project = this.snapshot.projects.find(
          (candidate) => candidate.projectId === command.projectId
        )
        if (!project) {
          return this.reject(command, 'invalid-target', 'Project 不存在')
        }
        const projectBlockReason = getProjectDispatchBlockReason(project)
        if (projectBlockReason) {
          return this.reject(
            command,
            'unavailable',
            projectExecutionUnavailableMessage(
              projectBlockReason,
              '发送新指令'
            )
          )
        }
        // Composer addresses exactly one instance — no multi-target fan-out.
        const agent = this.snapshot.agents.find(
          (a) =>
            a.agentInstanceId === command.agentInstanceId &&
            a.projectId === command.projectId
        )
        if (!agent) {
          return this.reject(command, 'invalid-target', 'Agent 不存在')
        }
        if (
          agent.runtimeState === 'unavailable' ||
          agent.runtimeState === 'archived'
        ) {
          return this.reject(
            command,
            'unavailable',
            'Agent 当前不可用，无法接收指令'
          )
        }
        // ADR-0007: structured Run and Terminal PTY are mutually exclusive per
        // instance. While Terminal takeover is active the adapter must refuse
        // a structured instruction even if the renderer mistakenly sends one.
        if (isTerminalExecutionSlotOccupied(agent.terminalState)) {
          return this.reject(
            command,
            'busy',
            'Terminal 正在打开或接管期间，不能发送结构化指令'
          )
        }
        // UX-v0.2 §6.3: only an explicitly needs-input Run may be replied to.
        // Any other active state must enqueue as the next Run instead of being
        // mistaken for a reply to the current Run.
        const canReply =
          agent.runtimeState === 'needs-input' &&
          command.mode === 'reply-current-run'
        if (command.mode === 'reply-current-run' && !canReply) {
          return this.reject(
            command,
            'busy',
            '当前没有待输入的 Run，不能回复；将作为下一 Run 入队'
          )
        }
        if (
          command.instruction === undefined ||
          command.instruction.trim().length === 0
        ) {
          return this.reject(command, 'invalid-target', '指令不能为空')
        }
        const planResult =
          command.mode === 'start-or-queue'
            ? buildDispatchPlan(this.snapshot, {
                expectedRevision: command.expectedRevision,
                projectId: command.projectId,
                targets: [command.agentInstanceId]
              })
            : null
        if (planResult && !planResult.ok) {
          return this.reject(
            command,
            planResult.reason,
            planResult.message
          )
        }
        // Phase 1 has no real runtime: recording the instruction is the only
        // side effect. No Run is created — we record an instruction-sent fact,
        // never a fake `run-started` (#6 P1-3).
        this.snapshot.activity = [
          {
            activityId: this.freshId('ActivityId'),
            projectId: agent.projectId,
            agentInstanceId: agent.agentInstanceId,
            timestamp: this.clock(),
            kind: 'instruction-sent',
            summary: `${agent.name} 收到指令：${command.instruction}`
          },
          ...this.snapshot.activity
        ]
        agent.lastActivityAt = this.clock()
        // #7 AC1: start-or-queue checks per-instance, Project and Global
        // capacity. Busy agents enqueue. Idle agents start if capacity
        // allows; otherwise they also enqueue.
        if (planResult?.ok) {
          if (planResult.plan.entries[0].outcome === 'queue') {
            this.enqueue(agent)
          } else {
            this.startMockRun(agent, agent.projectId)
          }
        }
        return null
      }
      case 'confirm-dispatch': {
        const planResult = buildDispatchPlan(this.snapshot, {
          expectedRevision: command.expectedRevision,
          projectId: command.projectId,
          targets: command.targets
        })
        if (!planResult.ok) {
          return this.reject(
            command,
            planResult.reason,
            planResult.message
          )
        }
        const { plan } = planResult
        const project = this.snapshot.projects.find(
          (candidate) => candidate.projectId === plan.projectId
        )!
        // Instruction must be non-empty (#6 P2-5).
        if (
          command.instruction === undefined ||
          command.instruction.trim().length === 0
        ) {
          return this.reject(command, 'invalid-target', '指令不能为空')
        }
        const targets = plan.entries.map(
          (entry) =>
            this.snapshot.agents.find(
              (agent) => agent.agentInstanceId === entry.agentInstanceId
            )!
        )
        // One stable, collision-free DispatchId per target — UUID, not
        // Date.now()+index, so two commands in the same millisecond cannot
        // share an id (#6 P1-2).
        const dispatchIds = targets.map(() => this.freshId('DispatchId'))
        const now = this.clock()
        const newActivity = targets.map((a) => ({
          activityId: this.freshId('ActivityId'),
          projectId: project.projectId,
          agentInstanceId: a.agentInstanceId,
          timestamp: now,
          // Record the dispatch fact only — never a fake `run-started`, since
          // no Run is actually created in Phase 1 (#6 P1-3).
          kind: 'dispatch-created' as const,
          summary: `${a.name} 收到派发：${command.instruction}`
        }))
        this.snapshot.activity = [...newActivity, ...this.snapshot.activity]
        for (const [index, a] of targets.entries()) {
          a.lastActivityAt = now
          if (plan.entries[index].outcome === 'queue') {
            this.enqueue(a)
          } else {
            this.startMockRun(a, project.projectId)
          }
        }
        // Queue a dispatch-created event to be emitted at the authoritative
        // revision after the success bump. Duplicate dispatch of the same
        // CommandId never reaches here (cached result short-circuits).
        postEvents.push({
          kind: 'dispatch-created',
          correlationId: command.commandId,
          dispatchIds
        })
        return null
      }
      case 'stage-configuration': {
        const applied = this.findAppliedConfig(command.owner)
        if (!applied) {
          return this.reject(command, 'invalid-target', '配置 owner 不存在')
        }
        if (!fieldPathsFor(command.owner).includes(command.fieldPath)) {
          return this.reject(command, 'invalid-target', '字段不存在')
        }
        // Staging only ever produces a draft — applied truth, active Runs
        // and identity stay untouched until an explicit apply (US-68).
        let draft = this.snapshot.configurationDrafts.find((d) =>
          sameOwner(d.owner, command.owner)
        )
        if (!draft) {
          draft = {
            owner: command.owner,
            appliedVersion: applied.appliedVersion,
            changes: [],
            validationErrors: []
          }
          this.snapshot.configurationDrafts.push(draft)
        }
        const appliedValue = applied.values[command.fieldPath]
        const changeIndex = draft.changes.findIndex(
          (c) => c.fieldPath === command.fieldPath
        )
        if (Object.is(command.value, appliedValue)) {
          // Staging the applied value back un-stages the change.
          if (changeIndex >= 0) draft.changes.splice(changeIndex, 1)
        } else if (changeIndex >= 0) {
          draft.changes[changeIndex] = {
            fieldPath: command.fieldPath,
            applied: appliedValue,
            draft: command.value
          }
        } else {
          draft.changes.push({
            fieldPath: command.fieldPath,
            applied: appliedValue,
            draft: command.value
          })
        }
        // Field-level validation is recorded on the draft so the editor can
        // show errors before any apply is attempted (US-70).
        draft.validationErrors = draft.validationErrors.filter(
          (e) => e.fieldPath !== command.fieldPath
        )
        const error = validateConfigurationValue(
          command.owner,
          command.fieldPath,
          command.value,
          this.snapshot
        )
        if (error) {
          draft.validationErrors.push({
            fieldPath: command.fieldPath,
            message: error
          })
        }
        if (draft.changes.length === 0 && draft.validationErrors.length === 0) {
          this.snapshot.configurationDrafts =
            this.snapshot.configurationDrafts.filter((d) => d !== draft)
        }
        return null
      }
      case 'discard-configuration': {
        const busy = this.rejectIfConfirmationPending(command)
        if (busy) return busy
        if (command.owners.length === 0) {
          return this.reject(command, 'invalid-target', '没有待丢弃的配置草稿')
        }
        const ownerKeys = command.owners.map((owner) => ownerKey(owner))
        if (new Set(ownerKeys).size !== ownerKeys.length) {
          return this.reject(command, 'invalid-target', 'owner 列表包含重复项')
        }
        // Batches stay inside one project: a Project Settings operation
        // must never touch another project's drafts (US-67, Project-first).
        const resolvedProjectIds = command.owners.map((owner) =>
          this.projectIdForOwner(owner)
        )
        if (resolvedProjectIds.some((projectId) => projectId === undefined)) {
          return this.reject(command, 'invalid-target', '配置 owner 不存在')
        }
        const projectIds = new Set(resolvedProjectIds)
        if (projectIds.size > 1) {
          return this.reject(
            command,
            'invalid-target',
            '一次只能丢弃同一 Project 的配置草稿'
          )
        }
        const drafts = command.owners.map((owner) =>
          this.snapshot.configurationDrafts.find(
            (draft) => ownerKey(draft.owner) === ownerKey(owner)
          )
        )
        if (drafts.some((draft) => !draft || draft.changes.length === 0)) {
          return this.reject(command, 'invalid-target', '没有待丢弃的配置草稿')
        }
        const frozenDrafts = structuredClone(
          drafts as ConfigurationDraftEntry[]
        )
        const target = command.owners
          .map((owner) => this.ownerLabelFor(owner))
          .join('、')
        const changes = frozenDrafts.flatMap((draft) =>
          draft.changes.map((change) => {
            const fieldLabel =
              fieldDescriptor(change.fieldPath)?.label ?? change.fieldPath
            return `${this.ownerLabelFor(draft.owner)} · ${fieldLabel}：${formatConfirmationValue(change.applied)} → ${formatConfirmationValue(change.draft)}`
          })
        )
        this.pendingAction = {
          type: 'discard-configuration',
          projectId: resolvedProjectIds[0]!,
          drafts: frozenDrafts
        }
        this.snapshot.pendingConfirmation = {
          confirmationId: id(crypto.randomUUID(), 'ConfirmationId'),
          action: '丢弃配置草稿',
          target,
          impact: `将永久丢弃以下 ${changes.length} 项配置草稿且不可恢复：${changes.join('；')}。`,
          nonBypassableReason: '丢弃配置草稿需要二次确认，无法跳过'
        }
        return null
      }
      case 'apply-configuration': {
        const keys = command.owners.map((o) => ownerKey(o.owner))
        const frozenOwnerKeys =
          this.pendingAction?.type === 'configuration-apply'
            ? this.pendingAction.plan.ownerKeys
            : null
        if (
          frozenOwnerKeys &&
          keys.some((key) => frozenOwnerKeys.includes(key))
        ) {
          return this.reject(
            command,
            'busy',
            '配置 owner 正在等待集成影响确认，请先确认或取消'
          )
        }
        if (new Set(keys).size !== keys.length) {
          return this.reject(command, 'invalid-target', 'owner 列表包含重复项')
        }
        if (command.owners.length === 0) {
          return this.reject(command, 'invalid-target', '没有待应用的草稿')
        }
        // Batches stay inside one project: a Project Settings operation
        // must never mutate another project's applied truth.
        const batchProjectIds = new Set(
          command.owners.map((o) => this.projectIdForOwner(o.owner))
        )
        if (batchProjectIds.has(undefined)) {
          return this.reject(command, 'invalid-target', '配置 owner 不存在')
        }
        if (batchProjectIds.size > 1) {
          return this.reject(
            command,
            'invalid-target',
            '一次只能应用同一 Project 的配置变更'
          )
        }
        const batchProjectId = [...batchProjectIds][0]!
        // Resolve and re-validate EVERY owner before mutating anything —
        // one failure aborts the whole apply with all drafts kept (US-70).
        const pending: Array<{
          owner: ConfigurationOwner
          draft: ConfigurationDraftEntry
          applied: AppliedConfigurationEntry
        }> = []
        for (const { owner, expectedAppliedVersion } of command.owners) {
          const applied = this.findAppliedConfig(owner)
          if (!applied) {
            return this.reject(command, 'invalid-target', '配置 owner 不存在')
          }
          if (applied.appliedVersion !== expectedAppliedVersion) {
            return this.reject(
              command,
              'stale-revision',
              '配置版本已过期，请查看最新值后重试'
            )
          }
          const draft = this.snapshot.configurationDrafts.find((d) =>
            sameOwner(d.owner, owner)
          )
          if (!draft || draft.changes.length === 0) {
            return this.reject(command, 'invalid-target', '没有待应用的草稿')
          }
          // The draft's own captured base is the real concurrency baseline:
          // a draft based on an older truth must never overwrite a newer
          // applied configuration, even when the caller claims otherwise.
          if (draft.appliedVersion !== applied.appliedVersion) {
            return this.reject(
              command,
              'stale-revision',
              '配置草稿基于过期的版本，请丢弃后重新暂存'
            )
          }
          pending.push({ owner, draft, applied })
        }
        // Agent-name validation must observe the atomic batch's FINAL name
        // set. Stage-time validation still uses the live snapshot for early
        // feedback, while Apply projects every pending rename together so a
        // legal swap/cycle is not rejected as a transient collision.
        const pendingRenames = new Map<AgentInstanceId, string>()
        for (const { owner, draft } of pending) {
          if (owner.kind !== 'agent') continue
          for (const change of draft.changes) {
            if (
              change.fieldPath === 'identity.name' &&
              typeof change.draft === 'string'
            ) {
              pendingRenames.set(owner.agentInstanceId, change.draft.trim())
            }
          }
        }
        const validationSnapshot: WorkbenchViewModel =
          pendingRenames.size === 0
            ? this.snapshot
            : {
                ...this.snapshot,
                agents: this.snapshot.agents.map((agent) => {
                  const finalName = pendingRenames.get(agent.agentInstanceId)
                  return finalName === undefined
                    ? agent
                    : { ...agent, name: finalName }
                })
              }
        // Re-validate against the projected snapshot — but publish failures
        // ONLY through this rejection. A rejected command never mutates the
        // snapshot (rejection purity), so freshly discovered errors travel
        // in the message instead of being written into drafts invisibly.
        const discovered: string[] = []
        for (const { owner, draft } of pending) {
          for (const change of draft.changes) {
            const error = validateConfigurationValue(
              owner,
              change.fieldPath,
              change.draft,
              validationSnapshot
            )
            if (error) {
              discovered.push(
                `${this.ownerLabelFor(owner)} · ${change.fieldPath}：${error}`
              )
            }
          }
        }
        if (discovered.length > 0) {
          return this.reject(
            command,
            'invariant-violation',
            `部分字段未通过验证（${discovered.join('；')}），已保留全部草稿`
          )
        }
        // Independently assert the projected FINAL name-set invariant after
        // all pending renames. This keeps Project-wide, case-insensitive
        // uniqueness (ADR-0008) explicit even if field validation evolves.
        if (pendingRenames.size > 0) {
          const seen = new Map<string, string>()
          let collision: string | null = null
          for (const agent of this.snapshot.agents.filter(
            (a) => a.projectId === batchProjectId
          )) {
            const finalName =
              pendingRenames.get(agent.agentInstanceId) ?? agent.name
            const key = finalName.toLowerCase()
            if (seen.has(key)) {
              collision = finalName
              break
            }
            seen.set(key, finalName)
          }
          if (collision) {
            return this.reject(
              command,
              'invariant-violation',
              `应用后 Agent 名称 "${collision}" 在 Project 内重复`
            )
          }
        }
        // Build the complete candidate without mutating live truth. A
        // destructive integration transition freezes this whole multi-owner
        // plan behind the shared confirmation contract.
        const commits = pending.map(({ owner, draft, applied }) => {
          const values = structuredClone(applied.values)
          for (const change of draft.changes) {
            values[change.fieldPath] = normalizeAppliedValue(
              change.fieldPath,
              change.draft
            )
          }
          return {
            owner: structuredClone(owner),
            values,
            appliedVersion: applied.appliedVersion + 1
          }
        })

        const plan: ConfigurationApplyPlan = {
          batchProjectId,
          ownerKeys: keys,
          commits
        }
        const projectPending = pending.find(
          ({ owner, draft }) =>
            owner.kind === 'project' &&
            draft.changes.some((change) =>
              change.fieldPath.startsWith('integrations.')
            )
        )
        if (projectPending) {
          const project = this.snapshot.projects.find(
            (candidate) => candidate.projectId === batchProjectId
          )!
          const projectCommit = commits.find(
            ({ owner }) => owner.kind === 'project'
          )!
          const requestedPrimary =
            projectCommit.values['integrations.primaryConnectionId']
          const nextPrimary =
            typeof requestedPrimary === 'string'
              ? id(requestedPrimary, 'ConnectionId')
              : undefined
          const primaryChanged = project.primaryConnectionId !== nextPrimary
          const scopeChanged = projectPending.draft.changes.some(
            (change) => change.fieldPath === 'integrations.resourceScope'
          )
          // Only already-authoritative bindings for the target ConnectionId
          // may survive. This preserves a trusted pre-authorised binding in
          // legacy state without ever fabricating identity from scope text.
          let nextBindings = project.resourceBindings.filter(
            (binding) => binding.connectionId === nextPrimary
          )
          if (scopeChanged) {
            const rawScope =
              projectCommit.values['integrations.resourceScope']
            const parsed =
              typeof rawScope === 'string'
                ? parseResourceScope(rawScope)
                : { ok: false as const, message: '资源范围必须是文本' }
            if (!parsed.ok) {
              return this.reject(
                command,
                'invariant-violation',
                `${parsed.message}，已保留全部草稿`
              )
            }
            const selected = new Set(parsed.labels)
            nextBindings = nextBindings.filter((binding) =>
              selected.has(binding.label)
            )
          }
          const kept = new Set(
            nextBindings.map((binding) => binding.bindingId as string)
          )
          const removedBindings = project.resourceBindings.filter(
            (binding) => !kept.has(binding.bindingId as string)
          )
          projectCommit.values['integrations.primaryConnectionId'] =
            nextPrimary ?? null
          projectCommit.values['integrations.resourceScope'] =
            formatResourceScope(nextBindings)
          plan.integration = {
            nextPrimary,
            nextBindings: structuredClone(nextBindings),
            removedBindings: structuredClone(removedBindings)
          }

          if (primaryChanged || removedBindings.length > 0) {
            if (this.snapshot.pendingConfirmation) {
              return this.reject(
                command,
                'busy',
                '已有待确认操作，请先确认或取消'
              )
            }
            const previousConnection = this.snapshot.global.connections.find(
              (connection) =>
                connection.connectionId === project.primaryConnectionId
            )
            const nextConnection = this.snapshot.global.connections.find(
              (connection) => connection.connectionId === nextPrimary
            )
            const bindingImpact = removedBindings
              .map(
                (binding) =>
                  `${binding.label}（${binding.resourceType}；${binding.allowedOperations.join('/')}）`
              )
              .join('、')
            const impact =
              removedBindings.length > 0
                ? `将解除 ${removedBindings.length} 个 Resource Binding：${bindingImpact}。解除后需重新授权才能恢复。`
                : '将解除 0 个 Resource Binding；当前没有绑定会丢失，但主连接差异仍需确认。'
            this.pendingAction = {
              type: 'configuration-apply',
              plan,
              fingerprint: this.configurationApplyFingerprint(
                batchProjectId,
                keys
              )
            }
            this.snapshot.pendingConfirmation = {
              confirmationId: this.freshId('ConfirmationId'),
              action: '确认集成绑定变更',
              target: `${project.name}：${previousConnection?.label ?? '无连接'} → ${nextConnection?.label ?? '无连接'}`,
              impact,
              nonBypassableReason:
                '主连接切换与破坏性解绑必须先确认影响，无法跳过'
            }
            return null
          }
        }

        if (
          !this.commitConfigurationApply(
            plan,
            postEvents,
            command.commandId
          )
        ) {
          return this.reject(
            command,
            'stale-revision',
            '配置 truth 已变化，请查看最新值后重试'
          )
        }
        return null
      }
      case 'manage-queue': {
        const item = this.snapshot.queue.find(
          (q) =>
            q.queueItemId === command.queueItemId &&
            q.projectId === command.projectId
        )
        if (!item) {
          return this.reject(command, 'invalid-target', '队列项不存在')
        }
        switch (command.operation) {
          case 'cancel': {
            const agent = this.snapshot.agents.find(
              (a) => a.agentInstanceId === item.agentInstanceId
            )
            this.snapshot.queue = this.snapshot.queue.filter(
              (q) => q.queueItemId !== item.queueItemId
            )
            const cancelledAt = this.clock()
            if (agent) {
              agent.queueDepth = this.snapshot.queue.filter(
                (queueItem) =>
                  queueItem.agentInstanceId === agent.agentInstanceId
              ).length
              // `queued` is not an active structured Run. Once the final
              // QueueItem is gone, restore the structured runtime to ready;
              // Terminal remains an orthogonal execution-slot fact.
              if (
                agent.queueDepth === 0 &&
                agent.runtimeState === 'queued'
              ) {
                agent.runtimeState = 'ready'
              }
              agent.lastActivityAt = cancelledAt
            }
            this.snapshot.activity = [
              {
                activityId: this.freshId('ActivityId'),
                projectId: item.projectId,
                agentInstanceId: item.agentInstanceId,
                queueItemId: item.queueItemId,
                timestamp: cancelledAt,
                kind: 'queue-cancelled',
                reason: 'user-cancelled',
                summary: `${agent?.name ?? item.agentInstanceId} 的排队项已由用户取消`
              },
              ...this.snapshot.activity
            ]
            // Renumber remaining items so positions stay sequential
            this.renumberProjectQueue(command.projectId)
            this.recomputeQueueCounts()
            break
          }
          case 'move-earlier': {
            if (item.position > 1) {
              const prev = this.snapshot.queue.find(
                (q) =>
                  q.projectId === item.projectId &&
                  q.position === item.position - 1
              )
              if (prev) {
                prev.position++
                item.position--
              }
            }
            break
          }
          case 'move-later': {
            const next = this.snapshot.queue.find(
              (q) =>
                q.projectId === item.projectId &&
                q.position === item.position + 1
            )
            if (next) {
              next.position--
              item.position++
            }
            break
          }
          case 'raise-priority':
          case 'lower-priority': {
            const nextPriority = stepQueuePriority(
              item.priority,
              command.operation
            )
            if (!nextPriority) {
              return this.reject(
                command,
                'invariant-violation',
                command.operation === 'raise-priority'
                  ? '队列项已是最高优先级'
                  : '队列项已是最低优先级'
              )
            }
            item.priority = nextPriority
            break
          }
        }
        return null
      }
      case 'answer-permission': {
        const request = this.snapshot.permissionRequests.find(
          (candidate) => candidate.requestId === command.requestId
        )
        if (
          !request ||
          request.projectId !== command.projectId ||
          request.agentInstanceId !== command.agentInstanceId ||
          request.runId !== command.runId
        ) {
          return this.reject(
            command,
            'invalid-target',
            '权限请求不存在或已处理'
          )
        }
        if (!request.decisions.includes(command.decision)) {
          return this.reject(
            command,
            'invalid-target',
            '该权限请求不提供此决定'
          )
        }
        // Timeout enforcement is an adapter-owned authoritative transition
        // (UX-v0.2 §10), never a renderer render-time inference. An answer
        // landing after the deadline collapses into the exact same deny
        // transition the expiry timer publishes — recorded exactly once.
        if (this.clock() >= request.expiresAt) {
          this.expirePermissionRequest(request, postEvents)
          return null
        }
        this.snapshot.permissionRequests =
          this.snapshot.permissionRequests.filter(
            (candidate) => candidate.requestId !== request.requestId
          )
        this.cancelPermissionTimer(request.requestId)
        const agent = this.snapshot.agents.find(
          (a) => a.agentInstanceId === request.agentInstanceId
        )
        // The decision releases the held Run only when no other pending
        // request still holds this Agent — the contract does not limit a
        // Run to a single outstanding request.
        const stillHeld = this.snapshot.permissionRequests.some(
          (candidate) => candidate.agentInstanceId === request.agentInstanceId
        )
        if (agent?.runtimeState === 'permission-requested' && !stillHeld) {
          agent.runtimeState = 'running'
        }
        const decidedAt = this.clock()
        if (agent) agent.lastActivityAt = decidedAt
        const decisionLabel =
          command.decision === 'deny'
            ? '已拒绝'
            : command.decision === 'allow-once'
              ? '已允许一次'
              : '已允许当前 Run'
        this.snapshot.activity = [
          {
            activityId: this.freshId('ActivityId'),
            projectId: request.projectId,
            agentInstanceId: request.agentInstanceId,
            timestamp: decidedAt,
            kind: 'permission-decided',
            summary: `${agent?.name ?? request.agentInstanceId} 的权限请求${decisionLabel}：${request.action}`
          },
          ...this.snapshot.activity
        ]
        this.resolveLinkedPermissionAttention(request, postEvents)
        this.recomputeAttentionCounts()
        return null
      }
      case 'resolve-attention': {
        const item = this.snapshot.attentionItems.find(
          (candidate) => candidate.attentionItemId === command.attentionItemId
        )
        if (!item || item.state !== 'open') {
          return this.reject(
            command,
            'invalid-target',
            '关注项不存在或已处理'
          )
        }
        // Fail closed: a permission-requested item is only ever resolved by
        // an actual permission decision. A direct resolve would be a fourth
        // action outside deny / allow-once / allow-current-run, strand the
        // held Run and write a misleading audit record.
        if (item.kind === 'permission-requested') {
          return this.reject(
            command,
            'invariant-violation',
            '权限类关注项只能通过权限决定处理'
          )
        }
        item.state = 'resolved'
        // Resolved items leave the pending list but stay visible as Project
        // Activity — the Center is a projection, not the record of truth.
        this.snapshot.activity = [
          {
            activityId: this.freshId('ActivityId'),
            projectId: item.target.projectId,
            timestamp: this.clock(),
            kind: 'attention-resolved',
            summary: `已处理关注：${item.title}`
          },
          ...this.snapshot.activity
        ]
        postEvents.push({
          kind: 'attention-changed',
          attentionItemId: item.attentionItemId,
          state: 'resolved'
        })
        this.recomputeAttentionCounts()
        return null
      }
      case 'set-terminal-takeover': {
        const project = this.snapshot.projects.find(
          (p) => p.projectId === command.projectId
        )
        if (!project) {
          return this.reject(command, 'invalid-target', 'Project 不存在')
        }
        const agent = this.snapshot.agents.find(
          (a) =>
            a.agentInstanceId === command.agentInstanceId &&
            a.projectId === command.projectId
        )
        if (!agent) {
          return this.reject(command, 'invalid-target', 'Agent 不存在')
        }
        if (command.operation === 'open') {
          const projectBlock = getProjectDispatchBlockReason(project)
          if (projectBlock) {
            return this.reject(
              command,
              'unavailable',
              projectExecutionUnavailableMessage(projectBlock, '接管 Terminal')
            )
          }
          // Only an active structured Run blocks Terminal — queued work does
          // not occupy the execution slot (ADR-0009 §显式执行与并发).
          if (isActiveStructuredRunState(agent.runtimeState)) {
            return this.reject(
              command,
              'busy',
              'Agent 正在运行结构化 Run，不能接管 Terminal'
            )
          }
          if (
            agent.runtimeState === 'unavailable' ||
            agent.runtimeState === 'archived'
          ) {
            return this.reject(
              command,
              'unavailable',
              'Agent 当前不可用，不能接管 Terminal'
            )
          }
          agent.terminalState = 'active'
        } else {
          agent.terminalState = 'closed'
        }
        return null
      }
      case 'import-handoff': {
        // AC2: inspect-only creates an inspectable record without producing a
        // Run; request-execute creates a confirmation with target/content
        // preview; execute-confirmed carries a confirmationId.
        const handoff = this.snapshot.handoffs.find(
          (h) => h.handoffId === command.handoffId
        )
        if (!handoff) {
          return this.reject(command, 'invalid-target', 'Handoff 不存在')
        }
        if (handoff.projectId !== command.projectId) {
          return this.reject(
            command,
            'invalid-target',
            'Handoff 不属于该 Project'
          )
        }
        const targetAgent = this.snapshot.agents.find(
          (a) =>
            a.agentInstanceId === command.targetAgentInstanceId &&
            a.projectId === command.projectId
        )
        if (!targetAgent) {
          return this.reject(
            command,
            'invalid-target',
            '目标 Agent 不存在'
          )
        }
        if (command.mode === 'inspect-only') {
          // Passive import: only creates an inspectable record. No Run, no
          // runtime state change (US-090).
          handoff.importState = 'inspect-only'
          this.snapshot.activity = [
            {
              activityId: this.freshId('ActivityId'),
              projectId: command.projectId,
              agentInstanceId: command.targetAgentInstanceId,
              timestamp: this.clock(),
              kind: 'instruction-sent',
              summary: `${targetAgent.name} 被动导入 Handoff：${handoff.goal}（仅检查，不执行）`
            },
            ...this.snapshot.activity
          ]
          postEvents.push({
            kind: 'handoff-imported',
            correlationId: command.commandId,
            handoffId: command.handoffId,
            mode: 'inspect-only'
          })
          return null
        }
        if (command.mode === 'request-execute') {
          // US-090: "导入并执行" must go through target preview and explicit
          // confirmation before producing a single execution Command.
          const busy = this.rejectIfConfirmationPending(command)
          if (busy) return busy
          this.pendingAction = {
            type: 'handoff-execute',
            projectId: command.projectId,
            handoffId: command.handoffId,
            targetAgentInstanceId: command.targetAgentInstanceId
          }
          const artifactList = handoff.artifacts
            .map(
              (a) =>
                `${a.path}（${a.status === 'included' ? '已包含' : '缺失'}）`
            )
            .join('、')
          const validationMsg =
            handoff.validation.status === 'pass'
              ? '验证通过'
              : handoff.validation.status === 'fail'
                ? `验证失败：${handoff.validation.message ?? ''}`
                : '验证待完成'
          this.snapshot.pendingConfirmation = {
            confirmationId: id(crypto.randomUUID(), 'ConfirmationId'),
            action: '导入并执行 Handoff',
            target: `${targetAgent.name} ← ${handoff.source.agentName}`,
            impact: `目标：${targetAgent.name}。内容：${handoff.goal}。基线 ${handoff.baseCommit}，产物：${artifactList}。${validationMsg}。`,
            nonBypassableReason:
              '导入并执行需要预览目标和内容后显式确认，无法跳过'
          }
          return null
        }
        // execute-confirmed: validate the confirmationId against the pending
        // handoff-execute action, then commit the import state.
        if (
          !this.pendingAction ||
          this.pendingAction.type !== 'handoff-execute' ||
          this.pendingAction.handoffId !== command.handoffId
        ) {
          return this.reject(
            command,
            'invalid-target',
            '没有待确认的 Handoff 执行请求'
          )
        }
        const pending = this.snapshot.pendingConfirmation
        if (!pending || pending.confirmationId !== command.confirmationId) {
          return this.reject(
            command,
            'invalid-target',
            '无效或过期的确认 ID'
          )
        }
        this.commitHandoffExecute(
          handoff,
          targetAgent,
          postEvents,
          command.commandId
        )
        return null
      }
      case 'request-quit-preview': {
        // AC3/AC4: quit preview shows active Runs, Terminals and
        // handoff-dirty Agents. Close window preserves background state;
        // quit is the explicit flow that surfaces these for user decision.
        this.snapshot.quitPreview = this.buildQuitPreview()
        return null
      }
      case 'execute-quit': {
        // AC4: quit actions require a prior request-quit-preview.
        if (!this.snapshot.quitPreview) {
          return this.reject(
            command,
            'invalid-target',
            '请先请求退出预览'
          )
        }
        switch (command.action) {
          case 'wait-for-runs': {
            // Close-window semantics: background state preserved (AC3).
            this.snapshot.quitPreview = undefined
            return null
          }
          case 'stop-runs': {
            this.stopActiveRunsForQuit()
            this.snapshot.quitPreview = undefined
            return null
          }
          case 'request-final-handoff': {
            this.generateQuitFallbackSnapshots()
            this.snapshot.quitPreview = undefined
            return null
          }
          case 'force-quit': {
            // Unblockable entry: stop everything and create fallback
            // snapshots in one step (AC4).
            this.stopActiveRunsForQuit()
            this.generateQuitFallbackSnapshots()
            this.snapshot.quitPreview = undefined
            return null
          }
        }
        return null
      }
      default:
        return this.reject(command, 'scenario-read-only', '此命令尚未实现')
    }
  }

  /**
   * Mints a collision-free branded ID. UUID-based so two commands issued in the
   * same millisecond (or even the same tick) can never share an id. Available
   * in renderer (Web Crypto) and Node ≥ 20 (`globalThis.crypto`).
   */
  private freshId<Name extends string>(name: Name): Brand<string, Name> {
    const uuid =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `id-${this.clock()}-${Math.random().toString(36).slice(2)}`
    return id(uuid, name)
  }

  /** Recomputes per-project queuedRunCount and global queuedGlobal. */
  private recomputeQueueCounts(): void {
    for (const project of this.snapshot.projects) {
      project.queuedRunCount = this.snapshot.queue.filter(
        (q) => q.projectId === project.projectId
      ).length
    }
    this.snapshot.global.concurrency.queuedGlobal = this.snapshot.queue.length
  }

  /** Occupies the execution slot: sets runtimeState and activeRunId, then
   *  projects the authoritative Agent states into Project / Global summaries.
   *  Does NOT record a `run-started`
   *  activity — Phase 1 does not create real Runs (#6 P1-3). */
  private startMockRun(
    agent: WorkbenchViewModel['agents'][number],
    projectId: ProjectId
  ): void {
    agent.runtimeState = 'running'
    agent.activeRunId = this.freshId('RunId')
    const project = this.snapshot.projects.find(
      (p) => p.projectId === projectId
    )
    if (project) {
      project.activity = 'active'
    }
    this.recomputeActiveRunCounts()
  }

  /** Rebuilds active summaries exclusively from authoritative Agent states. */
  private recomputeActiveRunCounts(): void {
    for (const project of this.snapshot.projects) {
      const activeRunCount = this.snapshot.agents.filter(
        (agent) =>
          agent.projectId === project.projectId &&
          isActiveStructuredRunState(agent.runtimeState)
      ).length
      project.activeRunCount = activeRunCount
    }
    this.snapshot.global.concurrency.activeGlobal = this.snapshot.agents.filter(
      (agent) => isActiveStructuredRunState(agent.runtimeState)
    ).length
  }

  /** Rebuilds attention summaries exclusively from authoritative open items. */
  private recomputeAttentionCounts(): void {
    for (const project of this.snapshot.projects) {
      project.attentionCount = this.snapshot.attentionItems.filter(
        (item) =>
          item.state === 'open' && item.target.projectId === project.projectId
      ).length
    }
    this.snapshot.global.attentionCount = this.snapshot.attentionItems.filter(
      (item) => item.state === 'open'
    ).length
  }

  /**
   * Builds the quit preview from authoritative Agent states and changes.
   * Active Runs are agents with an active structured Run state; active
   * Terminals have terminalState 'active'; handoff-dirty agents have
   * uncommitted worktree changes (#12 AC3/AC4).
   */
  private buildQuitPreview(): QuitPreviewViewModel {
    const activeRuns = this.snapshot.agents
      .filter((agent) => isActiveStructuredRunState(agent.runtimeState))
      .map((agent) => ({
        projectId: agent.projectId,
        agentInstanceId: agent.agentInstanceId,
        agentName: agent.name,
        runId: agent.activeRunId!,
        runtimeState: agent.runtimeState
      }))
    const activeTerminals = this.snapshot.agents
      .filter((agent) => agent.terminalState === 'active')
      .map((agent) => ({
        projectId: agent.projectId,
        agentInstanceId: agent.agentInstanceId,
        agentName: agent.name
      }))
    const handoffDirtyAgents = this.snapshot.changes.map((change) => {
      const agent = this.snapshot.agents.find(
        (a) => a.agentInstanceId === change.agentInstanceId
      )!
      return {
        projectId: agent.projectId,
        agentInstanceId: change.agentInstanceId,
        agentName: agent.name,
        changeSummary: `${change.files.length} 个文件变更（${change.drift === 'behind' ? 'base 已落后' : 'base 最新'}，验证：${change.validation.status}）`
      }
    })
    return { activeRuns, activeTerminals, handoffDirtyAgents }
  }

  /**
   * Transitions all active structured Runs to `interrupted` and closes all
   * active Terminals. Phase 1 has no real process — this only changes mock
   * state and re-projects the summaries (#12 AC4).
   */
  private stopActiveRunsForQuit(): void {
    for (const agent of this.snapshot.agents) {
      if (isActiveStructuredRunState(agent.runtimeState)) {
        agent.runtimeState = 'interrupted'
        agent.activeRunId = undefined
      }
      if (agent.terminalState === 'active') {
        agent.terminalState = 'closed'
      }
    }
    // Clear pending permission requests — their held Runs are gone.
    for (const request of [...this.snapshot.permissionRequests]) {
      this.cancelPermissionTimer(request.requestId)
    }
    this.snapshot.permissionRequests = []
    this.recomputeActiveRunCounts()
    this.recomputeAttentionCounts()
  }

  /**
   * Creates a deterministic fallback snapshot (incomplete Handoff) for each
   * agent with uncommitted worktree changes. These are marked as
   * `quit-snapshot` provenance with an explicit incomplete reason and
   * recovery actions, so they are never mistaken for complete handoffs
   * (#12 AC4, US-060).
   */
  private generateQuitFallbackSnapshots(): void {
    const now = this.clock()
    for (const change of this.snapshot.changes) {
      const agent = this.snapshot.agents.find(
        (a) => a.agentInstanceId === change.agentInstanceId
      )
      if (!agent) continue
      const fileList = change.files.map((f) => f.path).join('、')
      this.snapshot.handoffs.push({
        handoffId: this.freshId('HandoffId'),
        projectId: agent.projectId,
        source: {
          agentInstanceId: agent.agentInstanceId,
          agentName: agent.name
        },
        provenance: {
          origin: 'quit-snapshot',
          createdAt: now
        },
        goal: `退出 Agent Squad HQ 时为 ${agent.name} 生成的 fallback 快照`,
        summary: `Agent ${agent.name} 在退出时有 ${change.files.length} 个未提交改动（${fileList}）。验证状态：${change.validation.status}。`,
        baseCommit: change.baseCommit,
        changeSummary: `${change.files.length} 个文件变更（${change.drift === 'behind' ? 'base 已落后' : 'base 最新'}）`,
        artifacts: change.files.map((f) => ({
          path: f.path,
          status: 'included' as const
        })),
        validation: {
          status: change.validation.status,
          ...(change.validation.message
            ? { message: change.validation.message }
            : {})
        },
        completeness: 'incomplete',
        incompleteReason:
          '退出时自动生成的 fallback 快照，未经完整 handoff 流程；可能缺少验证结果或最新改动',
        recoveryActions: [
          `重新打开 ${agent.name} 并检查 worktree 改动`,
          `对 ${agent.name} 发起验证 Run 后标记为 complete`,
          '手动检查改动文件后合并或丢弃'
        ],
        importState: 'not-imported'
      })
    }
  }

  // -- Permission Center (#9) ---------------------------------------------

  /**
   * The single authoritative timeout transition: deny by default, remove the
   * request, release the held Run when nothing else holds it, resolve the
   * request's own attention reminder and audit the outcome. Used by the
   * construction sweep, the expiry timer and an answer landing after the
   * deadline — always recorded exactly once.
   */
  private expirePermissionRequest(
    request: WorkbenchViewModel['permissionRequests'][number],
    postEvents: PostDispatchEvent[]
  ): void {
    this.snapshot.permissionRequests = this.snapshot.permissionRequests.filter(
      (candidate) => candidate.requestId !== request.requestId
    )
    this.cancelPermissionTimer(request.requestId)
    const agent = this.snapshot.agents.find(
      (a) => a.agentInstanceId === request.agentInstanceId
    )
    // Another pending request on the same Agent keeps the Run held.
    const stillHeld = this.snapshot.permissionRequests.some(
      (candidate) => candidate.agentInstanceId === request.agentInstanceId
    )
    if (agent?.runtimeState === 'permission-requested' && !stillHeld) {
      agent.runtimeState = 'running'
    }
    const decidedAt = this.clock()
    if (agent) agent.lastActivityAt = decidedAt
    this.snapshot.activity = [
      {
        activityId: this.freshId('ActivityId'),
        projectId: request.projectId,
        agentInstanceId: request.agentInstanceId,
        timestamp: decidedAt,
        kind: 'permission-decided',
        summary: `${agent?.name ?? request.agentInstanceId} 的权限请求已拒绝：${request.action}（请求已超时，按拒绝处理）`
      },
      ...this.snapshot.activity
    ]
    this.resolveLinkedPermissionAttention(request, postEvents)
    this.recomputeAttentionCounts()
  }

  /**
   * A handled request clears only its own Attention projection in the same
   * transition: the open permission-requested item linked to exactly this
   * PermissionRequestId resolves. Concurrent requests keep their own
   * reminders — a broad Run/Agent match would clear them prematurely.
   */
  private resolveLinkedPermissionAttention(
    request: WorkbenchViewModel['permissionRequests'][number],
    postEvents: PostDispatchEvent[]
  ): void {
    for (const item of this.snapshot.attentionItems) {
      if (item.state !== 'open' || item.kind !== 'permission-requested') {
        continue
      }
      if (item.permissionRequestId !== request.requestId) continue
      item.state = 'resolved'
      postEvents.push({
        kind: 'attention-changed',
        attentionItemId: item.attentionItemId,
        state: 'resolved'
      })
    }
  }

  /**
   * Publishes the default-deny transition exactly at each request's
   * deadline. The callback re-checks the shared clock so an injected,
   * non-advancing clock never expires anything. Timers never hold a Node
   * process open for a mock timeout.
   */
  private schedulePermissionTimers(): void {
    for (const request of this.snapshot.permissionRequests) {
      const delay = request.expiresAt - this.clock()
      if (delay <= 0) continue
      const timer = setTimeout(() => {
        this.permissionTimers.delete(request.requestId)
        const pending = this.snapshot.permissionRequests.find(
          (candidate) => candidate.requestId === request.requestId
        )
        if (!pending) return // already decided or expired elsewhere
        if (this.clock() < pending.expiresAt) return // clock not there yet
        const postEvents: PostDispatchEvent[] = []
        this.expirePermissionRequest(pending, postEvents)
        const revision = ++this.snapshot.revision
        this.emit(
          {
            kind: 'view-model-updated',
            revision,
            snapshot: structuredClone(this.snapshot)
          },
          ...postEvents.map((partial) => ({ ...partial, revision }))
        )
      }, delay)
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        ;(timer as { unref: () => void }).unref()
      }
      this.permissionTimers.set(request.requestId, timer)
    }
  }

  private cancelPermissionTimer(requestId: PermissionRequestId): void {
    const timer = this.permissionTimers.get(requestId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.permissionTimers.delete(requestId)
    }
  }

  /** Renumbers queue items for a project to be sequential 1..N by current position. */
  private renumberProjectQueue(projectId: ProjectId): void {
    const items = this.snapshot.queue
      .filter((q) => q.projectId === projectId)
      .sort((a, b) => a.position - b.position)
    items.forEach((item, i) => {
      item.position = i + 1
    })
  }

  /**
   * Single atomic enqueue transition used by both dispatch and composer
   * (#6 P1-2). Updates the per-instance queueDepth, appends a visible
   * QueueItem, and keeps the Project / global queue summaries consistent so
   * Overview, Picker and any queue view observe the same facts.
   */
  private enqueue(
    agent: WorkbenchViewModel['agents'][number],
    priority: 'low' | 'normal' | 'high' = 'normal'
  ): void {
    const project = this.snapshot.projects.find(
      (p) => p.projectId === agent.projectId
    )
    if (!project) return
    // A capacity-blocked idle instance enters the observable queued state in
    // the same transition as its QueueItem. Existing structured Run or PTY
    // occupancy remains authoritative while additional work queues behind it.
    if (
      !isAgentBusy({
        runtimeState: agent.runtimeState,
        terminalState: agent.terminalState
      })
    ) {
      agent.runtimeState = 'queued'
    }
    agent.queueDepth += 1
    // Position is project-scoped sequential: next slot after all existing
    // queue items for this project, so reorder operations work correctly.
    const position =
      this.snapshot.queue.filter(
        (q) => q.projectId === agent.projectId
      ).length + 1
    const queueItemId = this.freshId('QueueItemId')
    this.snapshot.queue.push({
      queueItemId,
      projectId: agent.projectId,
      agentInstanceId: agent.agentInstanceId,
      position,
      priority
    })
    project.queuedRunCount = this.snapshot.queue.filter(
      (q) => q.projectId === project.projectId
    ).length
    this.snapshot.global.concurrency.queuedGlobal = this.snapshot.queue.length
  }

  /** A single shared confirmation slot cannot be replaced while pending. */
  private rejectIfConfirmationPending(
    command: WorkbenchCommand
  ): CommandResult | null {
    if (!this.snapshot.pendingConfirmation && !this.pendingAction) return null
    return this.reject(command, 'busy', '请先处理当前待确认操作')
  }

  /**
   * Finds the applied configuration truth for an owner, or undefined when
   * the owner does not exist (unknown project/agent).
   */
  private findAppliedConfig(owner: ConfigurationOwner) {
    return this.snapshot.appliedConfigurations.find(
      (c) => ownerKey(c.owner) === ownerKey(owner)
    )
  }

  /** Resolves which project an owner belongs to (undefined when unknown). */
  private projectIdForOwner(owner: ConfigurationOwner): ProjectId | undefined {
    if (owner.kind === 'project') {
      return this.snapshot.projects.some(
        (p) => p.projectId === owner.projectId
      )
        ? owner.projectId
        : undefined
    }
    return this.snapshot.agents.find(
      (a) => a.agentInstanceId === owner.agentInstanceId
    )?.projectId
  }

  /** Display label for rejection messages — never an identifier. */
  private ownerLabelFor(owner: ConfigurationOwner): string {
    if (owner.kind === 'project') {
      return (
        this.snapshot.projects.find((p) => p.projectId === owner.projectId)
          ?.name ?? owner.projectId
      )
    }
    return (
      this.snapshot.agents.find(
        (a) => a.agentInstanceId === owner.agentInstanceId
      )?.name ?? owner.agentInstanceId
    )
  }

  /** Projects whose structured or applied truth references a connection. */
  private connectionDeletionProjectIds(
    connectionId: ConnectionId
  ): ProjectId[] {
    const referenced = new Set<ProjectId>()
    for (const project of this.snapshot.projects) {
      if (
        project.primaryConnectionId === connectionId ||
        project.resourceBindings.some(
          (binding) => binding.connectionId === connectionId
        )
      ) {
        referenced.add(project.projectId)
      }
    }
    for (const config of this.snapshot.appliedConfigurations) {
      if (
        config.owner.kind === 'project' &&
        config.values['integrations.primaryConnectionId'] === connectionId
      ) {
        referenced.add(config.owner.projectId)
      }
    }
    return this.snapshot.projects
      .map((project) => project.projectId)
      .filter((projectId) => referenced.has(projectId))
  }

  /**
   * Freezes deletion impact without coupling it to unrelated Projects. A new
   * reference also changes `currentAffectedProjectIds`, expiring the preview.
   */
  private connectionDeletionFingerprint(
    connectionId: ConnectionId,
    expectedProjectIds: ProjectId[]
  ): string {
    const currentAffectedProjectIds =
      this.connectionDeletionProjectIds(connectionId)
    const relevant = new Set([
      ...expectedProjectIds,
      ...currentAffectedProjectIds
    ])
    return JSON.stringify({
      connection: this.snapshot.global.connections.find(
        (candidate) => candidate.connectionId === connectionId
      ),
      currentAffectedProjectIds,
      projects: this.snapshot.projects
        .filter((project) => relevant.has(project.projectId))
        .map((project) => ({
          projectId: project.projectId,
          name: project.name,
          primaryConnectionId: project.primaryConnectionId,
          resourceBindings: project.resourceBindings
        })),
      applied: this.snapshot.appliedConfigurations.filter(
        (config) =>
          config.owner.kind === 'project' &&
          relevant.has(config.owner.projectId)
      ),
      drafts: this.snapshot.configurationDrafts.filter(
        (draft) =>
          draft.owner.kind === 'project' &&
          relevant.has(draft.owner.projectId)
      )
    })
  }

  /**
   * Fingerprints only facts that can affect a frozen configuration plan.
   * Navigation, queue and runtime events do not expire a confirmation, while
   * owner drafts, applied truth, connection metadata or binding identity do.
   */
  private configurationApplyFingerprint(
    projectId: ProjectId,
    ownerKeys: string[]
  ): string {
    const selected = new Set(ownerKeys)
    const project = this.snapshot.projects.find(
      (candidate) => candidate.projectId === projectId
    )
    return JSON.stringify({
      project: project
        ? {
            projectId: project.projectId,
            name: project.name,
            primaryConnectionId: project.primaryConnectionId,
            resourceBindings: project.resourceBindings
          }
        : null,
      agentNames: this.snapshot.agents
        .filter((agent) => agent.projectId === projectId)
        .map((agent) => ({
          agentInstanceId: agent.agentInstanceId,
          name: agent.name
        })),
      applied: this.snapshot.appliedConfigurations.filter((entry) =>
        selected.has(ownerKey(entry.owner))
      ),
      drafts: this.snapshot.configurationDrafts.filter((entry) =>
        selected.has(ownerKey(entry.owner))
      ),
      connections: this.snapshot.global.connections
    })
  }

  /**
   * Commits a confirmed handoff execute: sets importState, clears the
   * confirmation, records activity and queues the handoff-imported event.
   * Phase 1 does NOT create a real Run — the user may explicitly start one
   * after the import (US-090).
   */
  private commitHandoffExecute(
    handoff: WorkbenchViewModel['handoffs'][number],
    targetAgent: WorkbenchViewModel['agents'][number],
    postEvents: PostDispatchEvent[],
    correlationId: CommandId
  ): void {
    handoff.importState = 'execute-confirmed'
    this.snapshot.pendingConfirmation = undefined
    this.pendingAction = null
    this.snapshot.activity = [
      {
        activityId: this.freshId('ActivityId'),
        projectId: targetAgent.projectId,
        agentInstanceId: targetAgent.agentInstanceId,
        timestamp: this.clock(),
        kind: 'dangerous-action-confirmed',
        summary: `${targetAgent.name} 已确认导入并执行 Handoff：${handoff.goal}`
      },
      ...this.snapshot.activity
    ]
    postEvents.push({
      kind: 'handoff-imported',
      correlationId,
      handoffId: handoff.handoffId,
      mode: 'execute-confirmed'
    })
  }

  /**
   * Commits a fully validated candidate in one in-memory transition. Every
   * target is checked before the first write so confirmation drift cannot
   * produce a half-applied batch.
   */
  private commitConfigurationApply(
    plan: ConfigurationApplyPlan,
    postEvents: PostDispatchEvent[],
    correlationId: CommandId
  ): boolean {
    const targets = plan.commits.map((commit) =>
      this.findAppliedConfig(commit.owner)
    )
    if (
      targets.some(
        (target, index) =>
          !target ||
          target.appliedVersion !== plan.commits[index].appliedVersion - 1
      )
    ) {
      return false
    }
    const project = this.snapshot.projects.find(
      (candidate) => candidate.projectId === plan.batchProjectId
    )
    if (plan.integration && !project) return false

    const appliedOwners: Array<{
      owner: ConfigurationOwner
      appliedVersion: number
    }> = []
    for (const [index, commit] of plan.commits.entries()) {
      const target = targets[index]!
      target.values = structuredClone(commit.values)
      target.appliedVersion = commit.appliedVersion
      appliedOwners.push({
        owner: structuredClone(commit.owner),
        appliedVersion: commit.appliedVersion
      })
      this.applyImmediateEffects(commit.owner, target.values)
    }
    if (plan.integration && project) {
      project.primaryConnectionId = plan.integration.nextPrimary
      project.resourceBindings = structuredClone(
        plan.integration.nextBindings
      )
    }

    const consumed = new Set(plan.ownerKeys)
    this.snapshot.configurationDrafts =
      this.snapshot.configurationDrafts.filter(
        (draft) => !consumed.has(ownerKey(draft.owner))
      )
    const singleAgentOwner =
      plan.commits.length === 1 && plan.commits[0].owner.kind === 'agent'
        ? plan.commits[0].owner
        : null
    this.snapshot.activity = [
      {
        activityId: this.freshId('ActivityId'),
        projectId: plan.batchProjectId,
        ...(singleAgentOwner
          ? { agentInstanceId: singleAgentOwner.agentInstanceId }
          : {}),
        timestamp: this.clock(),
        kind: 'configuration-applied',
        summary: `已原子应用 ${plan.commits.length} 个 owner 的配置变更`
      },
      ...this.snapshot.activity
    ]
    postEvents.push({
      kind: 'configuration-applied',
      correlationId,
      owners: appliedOwners
    })
    return true
  }

  /**
   * Applies the immediate effects of a committed configuration (US-91):
   * identity and routing metadata take effect at once. Run configuration
   * (model, permissions, proxy, env, resources, concurrency, budget) has NO
   * side effect here — it only takes effect on the next Run, and the active
   * Run keeps its launch-time snapshot (`activeRunConfigVersion`).
   */
  private applyImmediateEffects(
    owner: ConfigurationOwner,
    values: Record<string, unknown>
  ): void {
    if (owner.kind === 'agent') {
      const agent = this.snapshot.agents.find(
        (a) => a.agentInstanceId === owner.agentInstanceId
      )
      const name = values['identity.name']
      if (agent && typeof name === 'string' && name.trim()) {
        agent.name = name.trim()
      }
      return
    }
    const project = this.snapshot.projects.find(
      (p) => p.projectId === owner.projectId
    )
    if (!project) return
    const projectName = values['general.name']
    if (typeof projectName === 'string' && projectName.trim()) {
      project.name = projectName.trim()
    }
    // Project integration state is a single aggregate and is committed only
    // by `commitConfigurationApply`; applying an unrelated project field
    // must never rewrite its connection or structured bindings.
  }

  private reject(
    command: WorkbenchCommand,
    reason: CommandRejectionReason,
    message: string
  ): CommandResult {
    const result: CommandResult = {
      ok: false,
      commandId: command.commandId,
      reason,
      latestRevision: this.snapshot.revision,
      message
    }
    this.resultsByCommandId.set(command.commandId, result)
    this.emit({
      kind: 'command-rejected',
      revision: this.snapshot.revision,
      result: result as Extract<CommandResult, { ok: false }>
    })
    return result
  }

  private emit(...events: WorkbenchEvent[]): void {
    this.eventQueue.push(...events)
    if (this.emittingEvents) return

    this.emittingEvents = true
    try {
      while (this.eventQueue.length > 0) {
        const event = this.eventQueue.shift()!
        for (const listener of [...this.listeners]) {
          listener(event)
        }
      }
    } finally {
      this.emittingEvents = false
    }
  }
}
