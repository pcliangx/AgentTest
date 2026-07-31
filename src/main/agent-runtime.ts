import type { AgentAdapter, AgentEvent, AgentId } from './adapters/contract'
import { adapters as defaultAdapters } from './adapters/registry'
import { startRun, type AgentRunHandle } from './run-manager'
import type { SessionStore } from './session-store'

export type RunStartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'busy' | 'unknown-agent' | 'start-failed' }

export interface AgentRuntimeOptions {
  readonly adapters?: readonly AgentAdapter[]
  readonly resolveCwd: (agent: AgentId) => string
  readonly sessionStore: SessionStore
  readonly onEvent: (agent: AgentId, event: AgentEvent) => void
}

/** Owns structured runs, native resume, transcript fallback, and per-agent exclusivity. */
export class AgentRuntime {
  private readonly adapters: Map<AgentId, AgentAdapter>
  private readonly active = new Map<AgentId, AgentRunHandle>()

  constructor(private readonly options: AgentRuntimeOptions) {
    const definitions = options.adapters ?? defaultAdapters
    this.adapters = new Map(definitions.map((adapter) => [adapter.id, adapter]))
  }

  run(agent: AgentId, text: string): RunStartResult {
    if (this.active.has(agent)) return { ok: false, reason: 'busy' }
    const adapter = this.adapters.get(agent)
    if (!adapter) return { ok: false, reason: 'unknown-agent' }

    const nativeSessionId =
      adapter.conversationMode === 'native-resume'
        ? this.options.sessionStore.getNativeSessionId(agent)
        : undefined
    const shouldReplayTranscript =
      adapter.conversationMode === 'transcript' ||
      (!nativeSessionId && this.options.sessionStore.hasTurns(agent))
    const prompt = shouldReplayTranscript
      ? this.options.sessionStore.buildTranscript(agent, text)
      : text

    let assistant = ''
    let pendingNativeSessionId: string | null = null
    let turnCompleted = false
    let protocolError = false

    try {
      const handle = startRun({
        adapter,
        cwd: this.options.resolveCwd(agent),
        text: prompt,
        ...(nativeSessionId ? { nativeSessionId } : {}),
        onEvent: (event) => {
          if (event.kind === 'assistant-text') {
            const value = (event.payload as { text?: unknown }).text
            if (typeof value === 'string') assistant += value
          } else if (event.kind === 'session-identified') {
            const value = (event.payload as { sessionId?: unknown }).sessionId
            if (typeof value === 'string' && value.length > 0) pendingNativeSessionId = value
          } else if (event.kind === 'turn-complete') {
            turnCompleted = true
          } else if (event.kind === 'error') {
            protocolError = true
          }
          this.options.onEvent(agent, event)
        },
        onExit: (code, outcome) => {
          const succeeded = code === 0 && turnCompleted && !protocolError
          if (outcome.canceled) {
            // Retain the last known-good native session. Some CLIs can resume an
            // interrupted turn; if they cannot, the next failure clears it.
          } else if (succeeded) {
            if (pendingNativeSessionId && adapter.conversationMode === 'native-resume') {
              this.options.sessionStore.setNativeSessionId(agent, pendingNativeSessionId)
            }
            this.options.sessionStore.recordTurn(agent, text, assistant)
          } else if (nativeSessionId) {
            // A failed resumed process may point at an expired upstream session.
            // The next run will reseed from the bounded transcript.
            this.options.sessionStore.clearNativeSession(agent)
          }
          this.active.delete(agent)
        }
      })
      this.active.set(agent, handle)
      return { ok: true }
    } catch (error) {
      this.options.onEvent(agent, {
        kind: 'error',
        occurredAt: Date.now(),
        source: 'inferred',
        payload: {
          message: error instanceof Error ? error.message : String(error)
        }
      })
      return { ok: false, reason: 'start-failed' }
    }
  }

  cancel(agent: AgentId): boolean {
    const run = this.active.get(agent)
    if (!run) return false
    run.cancel()
    return true
  }

  isRunning(agent: AgentId): boolean {
    return this.active.has(agent)
  }

  async disposeAll(): Promise<void> {
    const active = [...this.active.entries()]
    for (const [, run] of active) run.cancel()
    await Promise.all(active.map(([, run]) => run.finished))
    for (const [agent, run] of active) {
      if (this.active.get(agent) === run) this.active.delete(agent)
    }
  }
}
