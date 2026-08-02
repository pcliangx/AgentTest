import type {
  AgentInstanceId,
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
      default:
        return this.reject(command, 'scenario-read-only', '此命令尚未实现')
    }
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
