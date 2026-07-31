// End-to-end check: spawns the REAL claude CLI through the adapter + run-manager and asserts the
// decoded event stream. Skipped by default (costs tokens); run with AGENTTEST_E2E=1.
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { claudeAdapter } from './adapter'
import { startRun } from '../../run-manager'
import { extractNativeSessionId, type AgentEvent } from '../contract'

const RUN = process.env['AGENTTEST_E2E'] === '1'

function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenttest-e2e-'))
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync(
    'git',
    ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'],
    { cwd: dir, stdio: 'ignore' }
  )
  return dir
}

describe.skipIf(!RUN)('Claude adapter e2e (real claude)', () => {
  it('spawns claude, decodes events, captures session id, completes the turn', async () => {
    const cwd = tempGitRepo()
    const events: AgentEvent[] = []

    await new Promise<void>((resolve) => {
      startRun({
        adapter: claudeAdapter,
        cwd,
        text: 'Reply with exactly: ready',
        onEvent: (e) => events.push(e),
        onExit: () => resolve()
      })
    })

    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('assistant-text')
    expect(kinds).toContain('turn-complete')
    expect(kinds).toContain('session-identified')

    const sid = extractNativeSessionId(events)
    expect(typeof sid).toBe('string')
    expect(sid!.length).toBeGreaterThan(0)

    // Structured stdout must remain decodable even when the local Claude profile has hooks/plugins.
    const errors = events.filter((e) => e.kind === 'error')
    expect(errors).toHaveLength(0)

    // follow-up @@claude resumes the native session via --resume <sid>
    const events2: AgentEvent[] = []
    await new Promise<void>((resolve) => {
      startRun({
        adapter: claudeAdapter,
        cwd,
        text: 'In one word, what did I just ask you to reply?',
        nativeSessionId: sid!,
        onEvent: (e) => events2.push(e),
        onExit: () => resolve()
      })
    })
    expect(events2.map((e) => e.kind)).toContain('turn-complete')
    expect(events2.filter((e) => e.kind === 'error')).toHaveLength(0)
  }, 90000)
})
