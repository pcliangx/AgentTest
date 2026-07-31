// AgentAdapter contract (v0.1, model-1: one-shot exec + native resume).
// Lean version of the architecture doc §6 interface — trimmed to what model-1 needs.
// registry.ts must compose adapters declaratively; switch(agentId) is forbidden (doc §2/§13).

export type AgentId = 'claude' | 'codex' | 'kimi'

export type AgentEventKind =
  | 'assistant-text'
  | 'tool-start'
  | 'tool-end'
  | 'usage'
  | 'turn-complete'
  | 'session-identified'
  | 'warning'
  | 'error'
  | 'process-exited'

export interface AgentEvent {
  readonly kind: AgentEventKind
  readonly occurredAt: number
  /** 'protocol' = straight from the agent's structured output; 'inferred' = guessed (never drives lifecycle). */
  readonly source: 'protocol' | 'inferred'
  readonly payload: unknown
}

export interface AgentAdapter {
  readonly id: AgentId
  readonly displayName: string
  /** Resolved executable path (discovered + trusted at launch). */
  readonly executable: string
  /** Per-agent auto-approve flags (e.g. ['--dangerously-skip-permissions']). See ADR-0003. */
  readonly autoApproveFlags: readonly string[]

  buildStartArgv(input: { readonly text: string }): readonly string[]
  buildResumeArgv(input: { readonly text: string; readonly nativeSessionId: string }): readonly string[]
  /** Incremental, bounded decoder: feed a stdout chunk, return zero or more events. */
  decode(chunk: Buffer): readonly AgentEvent[]
  extractSessionId(events: readonly AgentEvent[]): string | null
}
