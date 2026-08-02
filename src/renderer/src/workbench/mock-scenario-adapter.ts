import type {
  AgentInstanceId,
  Brand,
  CommandId,
  CommandRejectionReason,
  CommandResult,
  PanelId,
  ProjectViewModel,
  WorkbenchCommand,
  WorkbenchEvent,
  WorkbenchPort,
  WorkbenchViewModel
} from './contract'
import { id } from './contract'
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
        // Creation never produces a Run; opening only changes the layout.
        if (command.open === 'current-panel') {
          const panelId = this.ensurePanel(project)
          const panel = project.layout.panels[panelId]
          panel.tabs.push(agentInstanceId)
          panel.activeTabId = agentInstanceId
          project.layout.focusedPanelId = panelId
        }
        return null
      }
      case 'change-layout': {
        const project = this.snapshot.projects.find(
          (p) => p.projectId === command.projectId
        )
        if (!project) {
          return this.reject(command, 'invalid-target', 'Project 不存在')
        }
        return this.applyLayoutOperation(command, project)
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
      default:
        return this.reject(command, 'scenario-read-only', '此命令尚未实现')
    }
  }

  /**
   * Handles the view-only tab commands of `change-layout`. Split-tree
   * structure operations remain out of scope for the mock until #4.
   * Tab commands never touch runtime, PTY, session or instance lifecycle.
   */
  private applyLayoutOperation(
    command: Extract<WorkbenchCommand, { kind: 'change-layout' }>,
    project: ProjectViewModel
  ): CommandResult | null {
    const { operation } = command
    const layout = project.layout

    switch (operation.kind) {
      case 'open-tab': {
        // Validate the target instance FIRST: a rejected command must not
        // mutate the snapshot (no panel allocation before this point).
        const agent = this.snapshot.agents.find(
          (a) =>
            a.agentInstanceId === operation.agentInstanceId &&
            a.projectId === project.projectId
        )
        if (!agent) {
          return this.reject(command, 'invalid-target', 'Agent 不存在')
        }
        // When the workspace is empty there is no valid panel to target;
        // the layout owner allocates a fresh one instead of rejecting.
        const targetPanelId =
          Object.keys(layout.panels).length === 0
            ? this.ensurePanel(project)
            : operation.panelId
        const panel = layout.panels[targetPanelId]
        if (!panel) {
          return this.reject(command, 'invalid-target', 'Panel 不存在')
        }
        // One instance has at most one tab per main window: reopening an
        // already-open instance only focuses its existing unique tab.
        for (const [panelId, p] of Object.entries(layout.panels)) {
          if (p.tabs.includes(agent.agentInstanceId)) {
            p.activeTabId = agent.agentInstanceId
            layout.focusedPanelId = id(panelId, 'PanelId')
            return null
          }
        }
        panel.tabs.push(agent.agentInstanceId)
        panel.activeTabId = agent.agentInstanceId
        layout.focusedPanelId = targetPanelId
        return null
      }
      case 'activate-tab': {
        const panel = layout.panels[operation.panelId]
        if (!panel || !panel.tabs.includes(operation.agentInstanceId)) {
          return this.reject(command, 'invalid-target', 'Tab 不存在')
        }
        panel.activeTabId = operation.agentInstanceId
        layout.focusedPanelId = operation.panelId
        return null
      }
      case 'close-tab': {
        const panel = layout.panels[operation.panelId]
        if (!panel || !panel.tabs.includes(operation.agentInstanceId)) {
          return this.reject(command, 'invalid-target', 'Tab 不存在')
        }
        panel.tabs = panel.tabs.filter(
          (tabId) => tabId !== operation.agentInstanceId
        )
        if (panel.activeTabId === operation.agentInstanceId) {
          panel.activeTabId = panel.tabs[panel.tabs.length - 1]
        }
        // Single-panel workspace: closing the last tab yields the empty
        // workspace state. Pruning inside nested split trees is #4 scope.
        if (
          panel.tabs.length === 0 &&
          layout.root?.kind === 'panel' &&
          layout.root.panelId === operation.panelId
        ) {
          layout.root = null
          delete layout.panels[operation.panelId]
          layout.focusedPanelId = undefined
        }
        return null
      }
      default:
        return this.reject(
          command,
          'scenario-read-only',
          '此布局操作尚未实现'
        )
    }
  }

  /**
   * Returns the focused (or first) panel of the project, creating one when
   * the workspace is currently empty.
   */
  private ensurePanel(project: ProjectViewModel): PanelId {
    const layout = project.layout
    if (layout.focusedPanelId && layout.panels[layout.focusedPanelId]) {
      return layout.focusedPanelId
    }
    const first = Object.keys(layout.panels)[0]
    if (first) {
      return id(first, 'PanelId')
    }
    this.createdPanelCount++
    const panelId = id(`panel-created-${this.createdPanelCount}`, 'PanelId')
    layout.panels[panelId] = { tabs: [] }
    layout.root = { kind: 'panel', panelId }
    return panelId
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
