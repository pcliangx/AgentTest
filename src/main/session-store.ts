import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentId } from './adapters/contract'

const KNOWN: readonly AgentId[] = ['claude', 'codex', 'kimi']

/** Persists the most-recent nativeSessionId per agent (one ongoing conversation per agent in v0.1).
 *  Backed by a JSON file under userData. */
export class SessionStore {
  private readonly sessions = new Map<AgentId, string>()

  constructor(private readonly file: string) {
    try {
      const obj = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      for (const k of KNOWN) {
        if (typeof obj[k] === 'string') this.sessions.set(k, obj[k] as string)
      }
    } catch {
      // missing or corrupt -> start empty
    }
  }

  get(id: AgentId): string | undefined {
    return this.sessions.get(id)
  }

  set(id: AgentId, nativeSessionId: string): void {
    this.sessions.set(id, nativeSessionId)
    this.persist()
  }

  clear(id: AgentId): void {
    this.sessions.delete(id)
    this.persist()
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const obj: Record<string, string> = {}
      for (const [k, v] of this.sessions) obj[k] = v
      writeFileSync(this.file, JSON.stringify(obj, null, 2))
    } catch {
      // best-effort persistence
    }
  }
}
