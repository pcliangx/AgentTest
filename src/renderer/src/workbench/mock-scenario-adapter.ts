import type {
  AgentInstanceId,
  Brand,
  CommandId,
  CommandRejectionReason,
  CommandResult,
  PanelId,
  ConnectionId,
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
import type { ProjectDispatchBlockReason } from './dispatchability'
import {
  getDispatchBlockReason,
  getProjectDispatchBlockReason,
  isAgentBusy,
  isTerminalExecutionSlotOccupied
} from './dispatchability'

function projectExecutionUnavailableMessage(
  reason: ProjectDispatchBlockReason,
  action: '发送新指令' | '创建新派发'
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

type PostDispatchEvent = Omit<
  Extract<WorkbenchEvent, { kind: 'dispatch-created' }>,
  'revision'
>

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
        const provider = this.snapshot.global.providers.find(
          (p) => p.providerId === command.providerId
        )
        if (!provider) {
          return this.reject(command, 'invalid-target', 'Provider 不存在')
        }
        if (provider.status !== 'ready') {
          return this.reject(
            command,
            'unavailable',
            'Provider Doctor 未通过，不能创建实例'
          )
        }
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
          queueDepth: 0,
          doctor: 'ready',
          lastActivityAt: Date.now()
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
            }
          } else {
            // merge-changes or discard-changes: clear changes for the agent
            const agentId =
              this.pendingAction.type === 'merge-changes'
                ? this.pendingAction.agentInstanceId
                : (this.pendingAction as { agentInstanceId: AgentInstanceId })
                    .agentInstanceId
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
        // start-or-queue to a busy agent must enter the same observable queue
        // as a dispatch — otherwise the composer would silently drop work
        // (#6 P1-2).
        if (command.mode === 'start-or-queue' && isAgentBusy(agent)) {
          this.enqueue(agent)
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
          // Authoritative queue projection (#6 P1-2): a dispatch to a busy
          // agent (including one holding a Terminal takeover) enqueues through
          // one shared transition that keeps the
          // per-instance depth, the QueueItem list and the Project/global
          // summaries consistent. Idle agents start immediately (no queue).
          if (isAgentBusy(a)) this.enqueue(a)
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
      case 'manage-queue': {
        const item = this.snapshot.queue.find(
          (q) => q.queueItemId === command.queueItemId
        )
        if (!item) {
          return this.reject(command, 'invalid-target', '队列项不存在')
        }
        switch (command.operation) {
          case 'cancel': {
            this.snapshot.queue = this.snapshot.queue.filter(
              (q) => q.queueItemId !== item.queueItemId
            )
            // Decrement the agent's queue depth
            const agent = this.snapshot.agents.find(
              (a) => a.agentInstanceId === item.agentInstanceId
            )
            if (agent) agent.queueDepth = Math.max(0, agent.queueDepth - 1)
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
        const agent = this.snapshot.agents.find(
          (a) => a.agentInstanceId === command.agentInstanceId
        )
        if (!agent) {
          return this.reject(command, 'invalid-target', 'Agent 不存在')
        }
        if (command.operation === 'open') {
          if (isAgentBusy(agent)) {
            return this.reject(
              command,
              'busy',
              'Agent 正在运行结构化 Run，不能接管 Terminal'
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
    // Position within this agent's own queue = its new depth.
    const position = agent.queueDepth
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
