import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId } from './adapters/contract'

export interface WorktreeFile {
  readonly path: string
  readonly flag: string
}
export interface WorktreeStatus {
  readonly exists: boolean
  readonly files: readonly WorktreeFile[]
  readonly summary: string | null
}

/** Creates one git worktree per agent off a shared base repo (ADR-0002: isolation + comparable diffs).
 *  Unified — never branches on agent name. Uses arg arrays (no shell, no injection surface). */
export class WorktreeManager {
  constructor(private readonly root: string) {}

  pathFor(agentId: AgentId): string {
    return join(this.root, agentId)
  }

  ensureWorktree(baseRepo: string, agentId: AgentId): string {
    const wt = this.pathFor(agentId)
    // A git worktree has a `.git` file (not dir) — its presence means already set up.
    if (existsSync(join(wt, '.git'))) return wt
    mkdirSync(this.root, { recursive: true })
    execFileSync('git', ['-C', baseRepo, 'worktree', 'add', '--detach', wt, 'HEAD'], { stdio: 'ignore' })
    return wt
  }

  remove(agentId: AgentId): void {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', this.pathFor(agentId)], { stdio: 'ignore' })
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

  /** Snapshot of an agent's worktree changes (git status --short + diff --stat vs HEAD). */
  status(agentId: AgentId): WorktreeStatus {
    const wt = this.pathFor(agentId)
    if (!existsSync(join(wt, '.git'))) return { exists: false, files: [], summary: null }
    const files = this.parseStatus(this.runGit(wt, ['status', '--short']))
    const stat = this.runGit(wt, ['diff', 'HEAD', '--stat'])
    const lines = stat.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    const summary = lines.length > 0 ? lines[lines.length - 1] : null
    return { exists: true, files, summary }
  }

  private runGit(wt: string, args: readonly string[]): string {
    try {
      return execFileSync('git', ['-C', wt, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      return ''
    }
  }

  private parseStatus(out: string): WorktreeFile[] {
    return out
      .split('\n')
      .map((l) => l.replace(/\n$/, ''))
      .filter((l) => l.length > 0)
      .map((l) => {
        const flag = l.slice(0, 2)
        let path = l.slice(3)
        const arrow = path.indexOf(' -> ')
        if (arrow >= 0) path = path.slice(arrow + 4) // rename: show the new path
        return { path, flag }
      })
  }
}
