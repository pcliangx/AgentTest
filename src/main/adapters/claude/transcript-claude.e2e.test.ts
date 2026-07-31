// Real-claude transcript e2e: runs claude (one-shot) which writes a transcript, and verifies the
// TranscriptWatcher tails it from the REAL projects dir (realpath-encoded). Deterministic (one-shot
// completes); avoids flaky interactive-PTY input. Skipped by default; run with AGENTTEST_E2E=1.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { startRun } from '../../run-manager'
import { claudeAdapter } from './adapter'
import { TranscriptWatcher } from '../../transcript-watcher'
import { claudeProjectDir, mapClaudeTranscript } from './transcribe'
import type { AgentEvent } from '../contract'

const RUN = process.env['AGENTTEST_E2E'] === '1'

function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenttest-trcl-'))
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync(
    'git',
    ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'],
    { cwd: dir, stdio: 'ignore' }
  )
  return dir
}

describe.skipIf(!RUN)('Transcript sidecar vs real claude', () => {
  it('tails the transcript claude writes, via the realpath-encoded projects dir', async () => {
    const cwd = realpathSync(tempGitRepo())
    const events: AgentEvent[] = []
    const watcher = new TranscriptWatcher(
      { dir: claudeProjectDir(cwd), map: mapClaudeTranscript },
      (e) => events.push(e)
    )
    watcher.start()

    await new Promise<void>((resolve) => {
      startRun({
        adapter: claudeAdapter,
        cwd,
        text: 'Reply with exactly: ready',
        onEvent: () => {},
        onExit: () => resolve()
      })
    })
    await new Promise((r) => setTimeout(r, 1500)) // let the watcher's final tick land
    watcher.stop()

    const kinds = events.map((e) => e.kind)
    // Core sidecar value: the assistant message, token usage, and turn boundary from the transcript.
    expect(kinds).toContain('assistant-text')
    expect(kinds).toContain('usage')
    expect(kinds).toContain('turn-complete')
  }, 60000)
})
