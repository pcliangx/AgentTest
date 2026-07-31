import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId } from './adapters/contract'

/** Creates one git worktree per agent off a shared base repo (ADR-0002: isolation + comparable diffs).
 *  Unified — never branches on agent name. Uses arg arrays (no shell, no injection surface). */
export class WorktreeManager {
  constructor(private readonly root: string) {}

  ensureWorktree(baseRepo: string, agentId: AgentId): string {
    const wt = join(this.root, agentId)
    // A git worktree has a `.git` file (not dir) — its presence means already set up.
    if (existsSync(join(wt, '.git'))) return wt
    mkdirSync(this.root, { recursive: true })
    execFileSync('git', ['-C', baseRepo, 'worktree', 'add', '--detach', wt, 'HEAD'], { stdio: 'ignore' })
    return wt
  }

  remove(agentId: AgentId): void {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', join(this.root, agentId)], { stdio: 'ignore' })
    } catch {
      // best-effort
    }
  }

  /** Wipe all worktrees so the next ensureWorktree re-creates them off a (possibly new) base repo.
   *  Old base repos may retain a prunable worktree entry — harmless, `git worktree prune` cleans it. */
  clearAll(): void {
    rmSync(this.root, { recursive: true, force: true })
    mkdirSync(this.root, { recursive: true })
  }
}
