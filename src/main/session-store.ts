import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentId } from './adapters/contract'
import { APP_DISPLAY_NAME } from './app-identity'

const KNOWN: readonly AgentId[] = ['claude', 'codex', 'kimi']
const MAX_TURNS = 20
const MAX_MESSAGE_CHARS = 12_000

interface StoredTurn {
  readonly user: string
  readonly assistant: string
}

interface StoredAgentState {
  nativeSessionId?: string
  turns: StoredTurn[]
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text
  return `${text.slice(0, MAX_MESSAGE_CHARS)}\n\n[earlier content truncated by ${APP_DISPLAY_NAME}]`
}

function parseState(value: unknown): StoredAgentState {
  // Backward compatibility with v0.1's `{ claude: "<session-id>" }` format.
  if (typeof value === 'string') return { nativeSessionId: value, turns: [] }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { turns: [] }
  const raw = value as Record<string, unknown>
  const turns = Array.isArray(raw['turns'])
    ? raw['turns']
        .filter(
          (turn): turn is { user: string; assistant: string } =>
            Boolean(turn) &&
            typeof turn === 'object' &&
            typeof (turn as Record<string, unknown>)['user'] === 'string' &&
            typeof (turn as Record<string, unknown>)['assistant'] === 'string'
        )
        .slice(-MAX_TURNS)
    : []
  return {
    ...(typeof raw['nativeSessionId'] === 'string'
      ? { nativeSessionId: raw['nativeSessionId'] }
      : {}),
    turns
  }
}

/** Durable native conversation handles plus bounded transcript fallback per agent. */
export class SessionStore {
  private readonly states = new Map<AgentId, StoredAgentState>()

  constructor(private readonly file: string) {
    try {
      const object = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      for (const id of KNOWN) this.states.set(id, parseState(object[id]))
    } catch {
      for (const id of KNOWN) this.states.set(id, { turns: [] })
    }
  }

  getNativeSessionId(id: AgentId): string | undefined {
    return this.state(id).nativeSessionId
  }

  setNativeSessionId(id: AgentId, nativeSessionId: string): void {
    this.states.set(id, { ...this.state(id), nativeSessionId })
    this.persist()
  }

  clearNativeSession(id: AgentId): void {
    const state = this.state(id)
    this.states.set(id, { turns: state.turns })
    this.persist()
  }

  hasTurns(id: AgentId): boolean {
    return this.state(id).turns.length > 0
  }

  buildTranscript(id: AgentId, currentUserText: string): string {
    const parts: string[] = []
    for (const turn of this.state(id).turns) {
      parts.push(`## user\n${turn.user}`, `## assistant\n${turn.assistant}`)
    }
    parts.push(`## user\n${truncate(currentUserText)}`)
    return parts.join('\n\n')
  }

  recordTurn(id: AgentId, user: string, assistant: string): void {
    const state = this.state(id)
    const turns = [
      ...state.turns,
      {
        user: truncate(user),
        assistant: truncate(assistant || '[turn completed without assistant text]')
      }
    ].slice(-MAX_TURNS)
    this.states.set(id, { ...state, turns })
    this.persist()
  }

  clear(id: AgentId): void {
    this.states.set(id, { turns: [] })
    this.persist()
  }

  clearAll(): void {
    for (const id of KNOWN) this.states.set(id, { turns: [] })
    this.persist()
  }

  // Compatibility aliases for callers from the dormant v0.1 implementation.
  get(id: AgentId): string | undefined {
    return this.getNativeSessionId(id)
  }

  set(id: AgentId, nativeSessionId: string): void {
    this.setNativeSessionId(id, nativeSessionId)
  }

  private state(id: AgentId): StoredAgentState {
    return this.states.get(id) ?? { turns: [] }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const object: Partial<Record<AgentId, StoredAgentState>> = {}
      for (const [id, state] of this.states) object[id] = state
      writeFileSync(this.file, JSON.stringify(object, null, 2))
    } catch {
      // Best-effort persistence; an unwritable userData directory must not crash a run.
    }
  }
}
