import { describe, it, expect } from 'vitest'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { WorktreeManager } from './worktree-manager'

function tempGitRepoWithFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-'))
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'a@b'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'tracked.txt'), 'original')
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' })
  return dir
}

describe('WorktreeManager.status', () => {
  it('reports untracked + modified files, and exists=false before creation', () => {
    const base = tempGitRepoWithFile()
    const mgr = new WorktreeManager(join(base, 'wt-root'))

    expect(mgr.status('claude').exists).toBe(false) // not created yet

    const wt = mgr.ensureWorktree(base, 'claude')
    writeFileSync(join(wt, 'untracked.txt'), 'new')
    appendFileSync(join(wt, 'tracked.txt'), ' changed')

    const s = mgr.status('claude')
    expect(s.exists).toBe(true)
    expect(s.files.map((f) => f.path).sort()).toEqual(['tracked.txt', 'untracked.txt'])
    expect(s.files.map((f) => f.flag.trim())).toContain('??') // untracked
    expect(s.files.some((f) => f.flag.includes('M'))).toBe(true) // modified
  })
})
