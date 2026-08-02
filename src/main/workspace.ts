import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_TECHNICAL_NAME, resolveBaseRepositoryOverride } from './app-identity'

// Base repo that agent worktrees branch from. Order: user-picked (RepoPicker) > env > throwaway
// empty git repo (demo mode). Phase 4's RepoPicker sets the user-picked value.
let configured: string | undefined
let cachedTemp: string | undefined

export function setBaseRepo(path: string | undefined): void {
  configured = path
}

export function getDefaultBaseRepo(): string {
  if (configured) return configured
  // AGENT_SQUAD_HQ_BASE_REPO (or its legacy alias) is trusted developer input (dev/test
  // override); it is not validated like the user-picked path. A bad value fails visibly.
  const env = resolveBaseRepositoryOverride(process.env)
  if (env) return env
  if (cachedTemp) return cachedTemp

  cachedTemp = join(tmpdir(), `${APP_TECHNICAL_NAME}-base`)
  if (!existsSync(join(cachedTemp, '.git'))) {
    mkdirSync(cachedTemp, { recursive: true })
    execFileSync('git', ['init'], { cwd: cachedTemp, stdio: 'ignore' })
    // worktree add needs a resolvable HEAD -> one empty commit.
    execFileSync(
      'git',
      [
        '-c',
        `user.email=${APP_TECHNICAL_NAME}@local.invalid`,
        '-c',
        `user.name=${APP_TECHNICAL_NAME}`,
        'commit',
        '--allow-empty',
        '-m',
        'init'
      ],
      { cwd: cachedTemp, stdio: 'ignore' }
    )
  }
  return cachedTemp
}
