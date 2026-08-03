import type {
  AgentInstanceId,
  Brand,
  CommandId,
  CommandRejectionReason,
  CommandResult,
  ConnectionId,
  PanelId,
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
  fieldPathsFor,
  normalizeAppliedValue,
  ownerKey,
  sameOwner,
  validateConfigurationValue
} from './configuration'
import type { ConfigurationOwner } from './contract'
import type { ProjectDispatchBlockReason } from './dispatchability'
import {
  getDispatchBlockReason,
  getProjectDispatchBlockReason,
  isAgentBusy,
  isTerminalExecutionSlotOccupied
} from './dispatchability'
import { resolveProviderModelSelection } from './provider-capability'

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

type ConfigurationDraftEntry =
  WorkbenchViewModel['configurationDrafts'][number]
type AppliedConfigurationEntry =
  WorkbenchViewModel['appliedConfigurations'][number]

/** Runtime states that occupy the execution slot with an active structured Run. */
const ACTIVE_STRUCTURED_RUN_STATES: ReadonlySet<string> = new Set([
  'starting',
  'running',
  'finishing',
  'needs-input',
  'permission-requested'
])

/**
 * In-memory WorkbenchPort backed by a deterministic scenario snapshot.
 *
 * Phase 1 uses this adapter to drive the full renderer without any real
 * Agent, PTY, Git, Feishu or persistence side effects. Future real adapters
 * (main/preload) must satisfy the same contract suite.
 */
export class MockScenarioAdapter implements WorkbenchPort {
  private snapshot: WorkbenchViewModel
  private listeners = new Set<(event: WorkbenchEvent) => void>()
  private resultsByCommandId = new Map<CommandId, CommandResult>()
  private eventQueue: WorkbenchEvent[] = []
  private emittingEvents = false
  private createdAgentCount = 0
  private createdPanelCount = 0
  private createdSplitCount = 0
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
    | { type: 'connection-deletion'; connectionId: ConnectionId }
    | { type: 'merge-changes'; agentInstanceId: AgentInstanceId }
    | { type: 'discard-changes'; agentInstanceId: AgentInstanceId }
    | null = null

  constructor(snapshot: WorkbenchViewModel = createStandardScenario()) {
    this.snapshot = structuredClone(snapshot)
  }

  async getSnapshot(): Promise<WorkbenchViewModel> {
    return structuredClone(this.snapshot)
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
    const rejection = this.tryApply(command, postEvents)
    if (rejection) return rejection

    // 4. Success — bump revision, cache and emit the complete event batch.
    const acceptedRevision = ++this.snapshot.revision
    const result: CommandResult = {
      ok: true,
      commandId: command.commandId,
      acceptedRevision
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
    postEvents: PostDispatchEvent[]
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
          lastActivityAt: Date.now()
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
        if (command.open === 'current-panel') {
          // The reducer allocates the first panel when the workspace is
          // empty, so the placeholder panelId is never dereferenced then.
          const targetPanelId =
            project.layout.focusedPanelId ??
            (Object.keys(project.layout.panels)[0] as PanelId | undefined) ??
            id('panel-auto', 'PanelId')
          const result = applyLayoutOperation(
            project.layout,
            { kind: 'open-tab', panelId: targetPanelId, agentInstanceId },
            this.layoutIds
          )
          if (result.ok) project.layout = result.layout
        } else if (command.open === 'new-panel') {
          const result = applyLayoutOperation(
            project.layout,
            {
              kind: 'open-tab-in-new-panel',
              agentInstanceId,
              direction: 'horizontal'
            },
            this.layoutIds
          )
          if (result.ok) project.layout = result.layout
        }
        return null
      }
      case 'request-connection-deletion': {
        const conn = this.snapshot.global.connections.find(
          (c) => c.connectionId === command.connectionId
        )
        if (!conn) {
          return this.reject(command, 'invalid-target', '连接不存在')
        }
        this.pendingAction = {
          type: 'connection-deletion',
          connectionId: command.connectionId
        }
        const affectedProjects = this.snapshot.projects
          .filter((p) => p.primaryConnectionId === command.connectionId)
          .map((p) => p.name)
        let impact = `此操作将永久删除「${conn.label}」，且不可恢复。`
        if (affectedProjects.length > 0) {
          impact += `以下 Project 的主连接将被解除绑定：${affectedProjects.join('、')}。`
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
        const { action, target } = pending
        this.snapshot.pendingConfirmation = undefined
        // Execute the pending mock action.
        if (this.pendingAction) {
          if (this.pendingAction.type === 'connection-deletion') {
            const connId = this.pendingAction.connectionId
            this.snapshot.global.connections =
              this.snapshot.global.connections.filter(
                (c) => c.connectionId !== connId
              )
            for (const proj of this.snapshot.projects) {
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
              if (
                config.owner.kind === 'project' &&
                config.values['integrations.primaryConnectionId'] === connId
              ) {
                config.values['integrations.primaryConnectionId'] = null
                config.appliedVersion += 1
              }
            }
          } else {
            // merge-changes or discard-changes: both carry agentInstanceId
            const agentId = this.pendingAction.agentInstanceId
            this.snapshot.changes = this.snapshot.changes.filter(
              (c) => c.agentInstanceId !== agentId
            )
          }
          this.pendingAction = null
        }
        // Record as a global activity — no projectId attribution.
        this.snapshot.activity.unshift({
          activityId: id(crypto.randomUUID(), 'ActivityId'),
          timestamp: Date.now(),
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
        // Phase 1 has no real runtime: recording the instruction is the only
        // side effect. No Run is created — we record an instruction-sent fact,
        // never a fake `run-started` (#6 P1-3).
        this.snapshot.activity = [
          {
            activityId: this.freshId('ActivityId'),
            projectId: agent.projectId,
            agentInstanceId: agent.agentInstanceId,
            timestamp: Date.now(),
            kind: 'instruction-sent',
            summary: `${agent.name} 收到指令：${command.instruction}`
          },
          ...this.snapshot.activity
        ]
        agent.lastActivityAt = Date.now()
        // #7 AC1: start-or-queue checks per-instance, Project and Global
        // capacity. Busy agents enqueue. Idle agents start if capacity
        // allows; otherwise they also enqueue.
        if (command.mode === 'start-or-queue') {
          if (isAgentBusy(agent) || !this.canStartRun(agent.projectId)) {
            this.enqueue(agent)
          } else {
            this.startMockRun(agent, agent.projectId)
          }
        }
        return null
      }
      case 'confirm-dispatch': {
        const project = this.snapshot.projects.find(
          (p) => p.projectId === command.projectId
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
              '创建新派发'
            )
          )
        }
        // Instruction must be non-empty (#6 P2-5).
        if (
          command.instruction === undefined ||
          command.instruction.trim().length === 0
        ) {
          return this.reject(command, 'invalid-target', '指令不能为空')
        }
        // Targets must be non-empty and unique (#6 P2-5). Duplicates would
        // otherwise create multiple DispatchIds for the same instance.
        if (command.targets.length === 0) {
          return this.reject(command, 'invalid-target', '目标不能为空')
        }
        const dedup = new Set(command.targets as string[])
        if (dedup.size !== command.targets.length) {
          return this.reject(
            command,
            'invalid-target',
            '目标不能包含重复 Agent'
          )
        }
        // Atomic target validation: every requested target must exist, belong
        // to this project AND be dispatchable. A mixed valid/invalid set is
        // rejected as a whole — we never partially dispatch (#6 P2-5).
        const projectAgents = this.snapshot.agents.filter(
          (a) => a.projectId === project.projectId
        )
        const byId = new Map(
          projectAgents.map((a) => [a.agentInstanceId, a] as const)
        )
        let missing = false
        let nonDispatchable = false
        for (const tid of command.targets) {
          const a = byId.get(tid)
          if (!a) {
            missing = true
          } else if (getDispatchBlockReason(a)) nonDispatchable = true
        }
        if (missing) {
          return this.reject(
            command,
            'invalid-target',
            '部分目标 Agent 不存在，已拒绝整单派发'
          )
        }
        if (nonDispatchable) {
          return this.reject(
            command,
            'unavailable',
            '部分目标 Agent 不可派发，已拒绝整单派发'
          )
        }
        const targets = command.targets.map((tid) => byId.get(tid)!)
        // One stable, collision-free DispatchId per target — UUID, not
        // Date.now()+index, so two commands in the same millisecond cannot
        // share an id (#6 P1-2).
        const dispatchIds = targets.map(() => this.freshId('DispatchId'))
        const now = Date.now()
        const newActivity = targets.map((a) => ({
          activityId: this.freshId('ActivityId'),
          projectId: project.projectId,
          agentInstanceId: a.agentInstanceId,
          timestamp: now,
          // Record the dispatch fact only — never a fake `run-started`, since
          // no Run is actually created in Phase 1 (#6 P1-3).
          kind: 'dispatch-created',
          summary: `${a.name} 收到派发：${command.instruction}`
        }))
        this.snapshot.activity = [...newActivity, ...this.snapshot.activity]
        for (const a of targets) {
          a.lastActivityAt = now
          // #7 AC1: enforce per-instance (via isAgentBusy), Project (3) and
          // Global (6) limits. Busy agents enqueue. Idle agents start if
          // capacity is available; otherwise they also enqueue.
          if (isAgentBusy(a) || !this.canStartRun(project.projectId)) {
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
        // Batches stay inside one project: a Project Settings operation
        // must never touch another project's drafts (US-67, Project-first).
        const projectIds = new Set(
          command.owners
            .map((o) => this.projectIdForOwner(o))
            .filter((pid) => pid !== undefined)
        )
        if (projectIds.size > 1) {
          return this.reject(
            command,
            'invalid-target',
            '一次只能丢弃同一 Project 的配置草稿'
          )
        }
        // Discard drops drafts only — applied values were never touched.
        const drop = new Set(command.owners.map((o) => ownerKey(o)))
        this.snapshot.configurationDrafts =
          this.snapshot.configurationDrafts.filter(
            (d) => !drop.has(ownerKey(d.owner))
          )
        return null
      }
      case 'apply-configuration': {
        const keys = command.owners.map((o) => ownerKey(o.owner))
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
        // Commit: move draft values into applied truth, bump each owner's
        // version exactly once, then clear the consumed drafts.
        const appliedOwners: Array<{
          owner: ConfigurationOwner
          appliedVersion: number
        }> = []
        for (const { owner, draft, applied } of pending) {
          for (const change of draft.changes) {
            applied.values[change.fieldPath] = normalizeAppliedValue(
              change.fieldPath,
              change.draft
            )
          }
          applied.appliedVersion += 1
          appliedOwners.push({ owner, appliedVersion: applied.appliedVersion })
          this.applyImmediateEffects(owner, applied.values)
        }
        const consumed = new Set(keys)
        this.snapshot.configurationDrafts =
          this.snapshot.configurationDrafts.filter(
            (d) => !consumed.has(ownerKey(d.owner))
          )
        // Configuration audit must be attributable: Project Activity filters
        // by projectId, so an entry without one would vanish from the UI
        // (US-61). Batches are single-project by construction.
        const singleAgentOwner =
          pending.length === 1 && pending[0].owner.kind === 'agent'
            ? pending[0].owner
            : null
        this.snapshot.activity = [
          {
            activityId: this.freshId('ActivityId'),
            projectId: batchProjectId,
            ...(singleAgentOwner
              ? { agentInstanceId: singleAgentOwner.agentInstanceId }
              : {}),
            timestamp: Date.now(),
            kind: 'configuration-applied',
            summary: `已原子应用 ${pending.length} 个 owner 的配置变更`
          },
          ...this.snapshot.activity
        ]
        postEvents.push({
          kind: 'configuration-applied',
          correlationId: command.commandId,
          owners: appliedOwners
        })
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
            this.snapshot.queue = this.snapshot.queue.filter(
              (q) => q.queueItemId !== item.queueItemId
            )
            const agent = this.snapshot.agents.find(
              (a) => a.agentInstanceId === item.agentInstanceId
            )
            if (agent) {
              agent.queueDepth = Math.max(0, agent.queueDepth - 1)
              // Restore to ready when no active run and no remaining queue
              if (
                agent.queueDepth === 0 &&
                agent.runtimeState === 'queued'
              ) {
                agent.runtimeState = 'ready'
              }
            }
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
            item.priority = 'high'
            break
          case 'lower-priority':
            item.priority = 'low'
            break
        }
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
          if (ACTIVE_STRUCTURED_RUN_STATES.has(agent.runtimeState)) {
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
        : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

  /** True if Project and Global concurrency limits allow a new active Run. */
  private canStartRun(projectId: ProjectId): boolean {
    const project = this.snapshot.projects.find(
      (p) => p.projectId === projectId
    )
    if (!project) return false
    const { projectLimit, globalLimit } = this.snapshot.global.concurrency
    if (project.activeRunCount >= projectLimit) return false
    if (this.snapshot.global.concurrency.activeGlobal >= globalLimit) return false
    return true
  }

  /** Occupies the execution slot: sets runtimeState, activeRunId, increments
   *  Project and Global active counters. Does NOT record a `run-started`
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
      project.activeRunCount++
      project.activity = 'active'
    }
    this.snapshot.global.concurrency.activeGlobal++
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
    // The primary connection is an optional 0..1 reference (US-72). Scope
    // moves with it atomically: bindings of the old connection are invalid
    // under the new one and are dropped in the same transition.
    const connection = values['integrations.primaryConnectionId']
    const nextPrimary =
      typeof connection === 'string'
        ? id(connection, 'ConnectionId')
        : undefined
    project.resourceBindings = project.resourceBindings.filter(
      (b) => b.connectionId === nextPrimary
    )
    project.primaryConnectionId = nextPrimary
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
