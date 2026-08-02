// PTY e2e: spawns the REAL claude CLI interactively via node-pty and asserts TUI bytes stream back.
// Skipped by default; run with AGENT_SQUAD_HQ_E2E=1.
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { PtyManager } from './pty-manager'
import { WorktreeManager } from './worktree-manager'
import { isRealCliE2EEnabled } from './app-identity'

const RUN = isRealCliE2EEnabled(process.env)

function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-squad-hq-pty-'))
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync(
    'git',
    ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'],
    { cwd: dir, stdio: 'ignore' }
  )
  return dir
}

describe.skipIf(!RUN)('PtyManager (real agents)', () => {
  it('spawns claude interactively in a worktree and streams TUI bytes', async () => {
    const base = tempGitRepo()
    const worktrees = new WorktreeManager(join(base, 'worktrees'))
    let received = ''
    const mgr = new PtyManager(
      (a) => worktrees.ensureWorktree(base, a),
      (_a, data) => {
        received += data
      },
      () => {}
    )

    mgr.ensure('claude')
    await new Promise((resolve) => setTimeout(resolve, 4000))
    mgr.disposeAll()

    expect(received.length).toBeGreaterThan(0)
  }, 20000)
})
