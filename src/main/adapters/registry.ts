import type { AgentAdapter, AgentId } from './contract'
import { claudeAdapter } from './claude/adapter'

// Phase 1: only Claude is real. codex/kimi return undefined from getAdapter until Phase 2/3.
//
// INVARIANT: this file only composes. Adding an adapter must NOT require changes in router /
// run-manager / worktree-manager, and must NOT introduce switch(agentId) (doc §2/§13).
export const adapters: readonly AgentAdapter[] = [claudeAdapter]

const byId = new Map<AgentId, AgentAdapter>(adapters.map((a) => [a.id, a]))

export function getAdapter(id: AgentId): AgentAdapter | undefined {
  return byId.get(id)
}
