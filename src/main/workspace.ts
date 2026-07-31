import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Phase 1 stand-in for the "open a repo" flow (RepoPicker lands in Phase 4).
// If AGENTTEST_BASE_REPO is set, use it; otherwise create a throwaway empty git repo so agents
// run in an isolated, harmless cwd. Worktrees branch off this base.
let cached: string | undefined

export function getDefaultBaseRepo(): string {
  const env = process.env['AGENTTEST_BASE_REPO']
  if (env) return env
  if (cached) return cached

  cached = join(tmpdir(), 'agenttest-base')
  if (!existsSync(join(cached, '.git'))) {
    mkdirSync(cached, { recursive: true })
    execFileSync('git', ['init'], { cwd: cached, stdio: 'ignore' })
    // worktree add needs a resolvable HEAD -> one empty commit.
    execFileSync(
      'git',
      ['-c', 'user.email=agent@test', '-c', 'user.name=agenttest', 'commit', '--allow-empty', '-m', 'init'],
      { cwd: cached, stdio: 'ignore' }
    )
  }
  return cached
}
