import type { AgentAdapter, AgentId } from './contract'
import { claudeAdapter } from './claude/adapter'
import { codexAdapter } from './codex/adapter'
import { kimiAdapter } from './kimi/adapter'

// INVARIANT: this file only composes. Adding an adapter must NOT require changes in router /
// run-manager / worktree-manager, and must NOT introduce switch(agentId) (doc §2/§13).
export const adapters: readonly AgentAdapter[] = [claudeAdapter, codexAdapter, kimiAdapter]

const byId = new Map<AgentId, AgentAdapter>(adapters.map((a) => [a.id, a]))

export function getAdapter(id: AgentId): AgentAdapter | undefined {
  return byId.get(id)
}

export function isAgentId(value: string): value is AgentId {
  return byId.has(value as AgentId)
}
