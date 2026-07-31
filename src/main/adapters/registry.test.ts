import { describe, expect, it } from 'vitest'
import { adapters, getAdapter, isAgentId } from './registry'
import { createClaudeAdapter } from './claude/adapter'

describe('agent registry', () => {
  it('registers all structured runtimes without router-specific branches', () => {
    expect(adapters.map((adapter) => adapter.id)).toEqual(['claude', 'codex', 'kimi'])
    expect(isAgentId('claude')).toBe(true)
    expect(isAgentId('unknown')).toBe(false)
  })

  it('builds protocol-correct fresh and resume invocations', () => {
    const claude = getAdapter('claude')!
    const claudeArgs = claude.buildArgv({ cwd: '/worktree' })
    expect(claudeArgs).toContain('--input-format')
    expect(claudeArgs).toContain('bypassPermissions')
    expect(claudeArgs).not.toContain('--bare')
    expect(claudeArgs).not.toContain('the prompt belongs on stdin')
    expect(
      claude.buildArgv({ cwd: '/worktree', nativeSessionId: 'session-1' }).slice(-2)
    ).toEqual(['--resume', 'session-1'])

    const codex = getAdapter('codex')!
    expect(codex.buildArgv({ cwd: '/worktree' }).slice(0, 2)).toEqual(['exec', '--json'])
    const codexResume = codex.buildArgv({
      cwd: '/worktree',
      nativeSessionId: 'thread-1'
    })
    expect(codexResume.slice(0, 3)).toEqual(['exec', 'resume', '--json'])
    expect(codexResume).not.toContain('-C')
    expect(codexResume.at(-1)).toBe('thread-1')

    expect(getAdapter('kimi')?.buildArgv({ cwd: '/worktree' })).toEqual(['acp'])
  })

  it('gates optional Claude partial events on the installed CLI capability', () => {
    const supported = createClaudeAdapter({
      executable: 'claude',
      partialMessages: true
    })
    const unsupported = createClaudeAdapter({
      executable: 'claude',
      partialMessages: false
    })

    expect(supported.buildArgv({ cwd: '/worktree' })).toContain(
      '--include-partial-messages'
    )
    expect(unsupported.buildArgv({ cwd: '/worktree' })).not.toContain(
      '--include-partial-messages'
    )
  })
})
