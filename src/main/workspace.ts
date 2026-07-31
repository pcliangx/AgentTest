import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Base repo that agent worktrees branch from. Order: user-picked (RepoPicker) > env > throwaway
// empty git repo (demo mode). Phase 4's RepoPicker sets the user-picked value.
let configured: string | undefined
let cachedTemp: string | undefined

export function setBaseRepo(path: string | undefined): void {
  configured = path
}

export function getDefaultBaseRepo(): string {
  if (configured) return configured
  const env = process.env['AGENTTEST_BASE_REPO']
  if (env) return env
  if (cachedTemp) return cachedTemp

  cachedTemp = join(tmpdir(), 'agenttest-base')
  if (!existsSync(join(cachedTemp, '.git'))) {
    mkdirSync(cachedTemp, { recursive: true })
    execFileSync('git', ['init'], { cwd: cachedTemp, stdio: 'ignore' })
    // worktree add needs a resolvable HEAD -> one empty commit.
    execFileSync(
      'git',
      ['-c', 'user.email=agent@test', '-c', 'user.name=agenttest', 'commit', '--allow-empty', '-m', 'init'],
      { cwd: cachedTemp, stdio: 'ignore' }
    )
  }
  return cachedTemp
}
