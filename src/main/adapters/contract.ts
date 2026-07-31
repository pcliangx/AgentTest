// Declarative runtime definition. The shared run module owns process lifecycle;
// adapters only describe launch, conversation continuity, and wire protocol.
// registry.ts must compose adapters declaratively; switch(agentId) is forbidden.

export type AgentId = 'claude' | 'codex' | 'kimi'

export type AgentEventKind =
  | 'assistant-text'
  | 'thinking'
  | 'status'
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

export interface AgentEventDecoder {
  push(raw: unknown): readonly AgentEvent[]
}

export type AgentProtocol =
  | {
      readonly kind: 'jsonl'
      readonly promptInput: 'text' | 'claude-stream-json'
      readonly createDecoder: () => AgentEventDecoder
    }
  | {
      readonly kind: 'acp-json-rpc'
      readonly stageTimeoutMs?: number
    }

export interface BuildArgvInput {
  readonly cwd: string
  readonly nativeSessionId?: string
}

export interface AgentAdapter {
  readonly id: AgentId
  readonly displayName: string
  /** Resolved executable path (discovered + trusted at launch). */
  readonly executable: string
  /** Arguments used only by the explicit Terminal/takeover mode. */
  readonly terminalArgv: readonly string[]
  /** Native resume sends only the latest turn; transcript mode replays prior completed turns. */
  readonly conversationMode: 'native-resume' | 'transcript'
  readonly protocol: AgentProtocol

  buildArgv(input: BuildArgvInput): readonly string[]
}

export function extractNativeSessionId(events: readonly AgentEvent[]): string | null {
  for (const event of events) {
    if (event.kind !== 'session-identified') continue
    const sessionId = (event.payload as { sessionId?: unknown }).sessionId
    if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId
  }
  return null
}
