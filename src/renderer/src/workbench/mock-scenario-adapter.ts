import type {
  AgentInstanceId,
  CommandId,
  CommandRejectionReason,
  CommandResult,
  PanelId,
  ProjectViewModel,
  ConnectionId,
  WorkbenchCommand,
  WorkbenchEvent,
  WorkbenchPort,
  WorkbenchViewModel
} from './contract'
import { id } from './contract'
import { createStandardScenario } from './standard-scenario'

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
  private createdAgentCount = 0
  private createdPanelCount = 0
  private pendingAction:
    | { type: 'connection-deletion'; connectionId: ConnectionId }
    | { type: 'merge-changes'; agentInstanceId: AgentInstanceId }
    | { type: 'discard-changes'; agentInstanceId: AgentInstanceId }
    | null = null

  constructor() {
    this.snapshot = createStandardScenario()
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
    const rejection = this.tryApply(command)
    if (rejection) return rejection

    // 4. Success — bump revision, emit, cache.
    this.snapshot.revision++
    const result: CommandResult = {
      ok: true,
      commandId: command.commandId,
      acceptedRevision: this.snapshot.revision
    }
    this.resultsByCommandId.set(command.commandId, result)
    this.emit({
      kind: 'view-model-updated',
      revision: this.snapshot.revision,
      correlationId: command.commandId,
      snapshot: structuredClone(this.snapshot)
    })
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
  private tryApply(command: WorkbenchCommand): CommandResult | null {
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
        const name = command.name.trim()
        if (!name) {
          return this.reject(command, 'invalid-target', 'Agent 名称不能为空')
        }
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
        return this.applyLayoutOperation(command, project)
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

  private emit(event: WorkbenchEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
