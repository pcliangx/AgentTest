import type {
  CommandId,
  CommandRejectionReason,
  CommandResult,
  PanelId,
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
