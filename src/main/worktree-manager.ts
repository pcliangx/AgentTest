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

export type ApplyFailReason = 'no-worktree' | 'no-changes' | 'dirty-base' | 'diverged' | 'git-error'
export type ApplyResult = { readonly ok: true; readonly branch: string } | { readonly ok: false; readonly reason: ApplyFailReason }

/** Creates one git worktree per agent off a shared base repo (ADR-0002). Unified — never branches on
 *  agent name. Uses arg arrays (no shell, no injection surface). */
export class WorktreeManager {
  constructor(private readonly root: string) {}

  pathFor(agentId: AgentId): string {
    return join(this.root, agentId)
  }

  ensureWorktree(baseRepo: string, agentId: AgentId): string {
    const wt = this.pathFor(agentId)
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

  /** Land an agent's worktree changes into the base repo: commit them on a temp branch, then
   *  fast-forward the base's current branch. Safe: refuses if the base is dirty or has diverged
   *  (never leaves a half-merged state). The worktree switches from detached HEAD onto the branch. */
  applyToBase(agentId: AgentId, baseRepo: string): ApplyResult {
    const wt = this.pathFor(agentId)
    if (!existsSync(join(wt, '.git'))) return { ok: false, reason: 'no-worktree' }
    if (this.runGit(baseRepo, ['status', '--porcelain']).trim() !== '') return { ok: false, reason: 'dirty-base' }
    if (this.runGit(wt, ['status', '--porcelain']).trim() === '') return { ok: false, reason: 'no-changes' }

    const branch = `agenttest/${agentId}-${Date.now()}`
    if (!this.runGitOk(wt, ['checkout', '-B', branch])) return { ok: false, reason: 'git-error' }
    this.runGitOk(wt, ['add', '-A'])
    if (
      !this.runGitOk(wt, [
        '-c',
        'user.email=agent@test',
        '-c',
        'user.name=agenttest',
        'commit',
        '-m',
        `agenttest: apply @@${agentId} changes`
      ])
    ) {
      return { ok: false, reason: 'git-error' }
    }
    if (!this.runGitOk(baseRepo, ['merge', '--ff-only', branch])) {
      this.runGitOk(baseRepo, ['merge', '--abort']) // never leave a conflicted merge behind
      return { ok: false, reason: 'diverged' }
    }
    return { ok: true, branch }
  }

  private runGit(wt: string, args: readonly string[]): string {
    try {
      return execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return ''
    }
  }

  private runGitOk(wt: string, args: readonly string[]): boolean {
    try {
      execFileSync('git', ['-C', wt, ...args], { stdio: 'ignore' })
      return true
    } catch {
      return false
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
