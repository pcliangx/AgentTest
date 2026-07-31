import { describe, it, expect } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
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

// Worktree root MUST live outside the base repo, else the base sees it as untracked (just like
// production, where the root is under userData, not inside the user's repo).
function setup(): { base: string; mgr: WorktreeManager } {
  return { base: tempGitRepoWithFile(), mgr: new WorktreeManager(mkdtempSync(join(tmpdir(), 'agenttest-wtroot-'))) }
}

function porcelain(dir: string): string {
  return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
}

describe('WorktreeManager.status', () => {
  it('reports untracked + modified files, and exists=false before creation', () => {
    const { base, mgr } = setup()

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

describe('WorktreeManager.applyToBase', () => {
  it('fast-forwards worktree changes into the base repo', () => {
    const { base, mgr } = setup()
    const wt = mgr.ensureWorktree(base, 'claude')
    writeFileSync(join(wt, 'new.txt'), 'from agent')

    const r = mgr.applyToBase('claude', base)

    expect(r.ok).toBe(true)
    expect(existsSync(join(base, 'new.txt'))).toBe(true) // landed
    expect(porcelain(base)).toBe('') // base clean afterwards
  })

  it('refuses when the base repo is dirty', () => {
    const { base, mgr } = setup()
    writeFileSync(join(mgr.ensureWorktree(base, 'claude'), 'new.txt'), 'x')
    appendFileSync(join(base, 'tracked.txt'), ' dirty') // dirty base

    const r = mgr.applyToBase('claude', base)

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('dirty-base')
  })

  it('refuses and stays clean when the base has diverged (not fast-forward)', () => {
    const { base, mgr } = setup()
    writeFileSync(join(mgr.ensureWorktree(base, 'claude'), 'new.txt'), 'x')

    // base advances after the agent started
    writeFileSync(join(base, 'base-change.txt'), 'y')
    execFileSync('git', ['-C', base, 'add', '.'], { stdio: 'ignore' })
    execFileSync('git', ['-C', base, 'commit', '-m', 'base advanced'], { stdio: 'ignore' })

    const r = mgr.applyToBase('claude', base)

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('diverged')
    expect(porcelain(base)).toBe('') // failed merge aborted, base left clean
  })
})
