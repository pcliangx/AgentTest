import type { AgentAdapter, AgentId } from './contract'

// Phase 0: no real adapters yet — the dummy run bypasses this registry (see run-manager.ts).
// Phase 1 plugs in the Claude adapter here; Phase 2/3 add codex/kimi.
//
// INVARIANT: this file only composes. Adding a fourth adapter must NOT require changes in
// router / run-manager / worktree-manager, and must NOT introduce switch(agentId) (doc §2/§13).
export const adapters: readonly AgentAdapter[] = []

const byId = new Map<AgentId, AgentAdapter>(adapters.map((a) => [a.id, a]))

export function getAdapter(id: AgentId): AgentAdapter | undefined {
  return byId.get(id)
}
