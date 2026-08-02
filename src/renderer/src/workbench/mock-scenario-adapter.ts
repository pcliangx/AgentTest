import type {
  CommandId,
  CommandRejectionReason,
  CommandResult,
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
  private pendingConnectionId: ConnectionId | null = null

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
      case 'request-connection-deletion': {
        const conn = this.snapshot.global.connections.find(
          (c) => c.connectionId === command.connectionId
        )
        if (!conn) {
          return this.reject(command, 'invalid-target', '连接不存在')
        }
        this.pendingConnectionId = command.connectionId
        this.snapshot.pendingConfirmation = {
          confirmationId: id(crypto.randomUUID(), 'ConfirmationId'),
          action: '删除连接',
          target: conn.label,
          impact: `此操作将永久删除「${conn.label}」，且不可恢复。`,
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
        // Mock result: remove the connection if one was pending deletion.
        if (this.pendingConnectionId) {
          this.snapshot.global.connections =
            this.snapshot.global.connections.filter(
              (c) => c.connectionId !== this.pendingConnectionId
            )
          this.pendingConnectionId = null
        }
        // Record as a global activity — no projectId attribution.
        this.snapshot.activity.unshift({
          activityId: id(`act-${Date.now()}`, 'ActivityId'),
          timestamp: Date.now(),
          kind: 'dangerous-action-confirmed',
          summary: `已确认: ${action}（${target}）`
        })
        return null
      }
      case 'dismiss-confirmation': {
        this.snapshot.pendingConfirmation = undefined
        this.pendingConnectionId = null
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
