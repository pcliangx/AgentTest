import { describe, it, expect } from 'vitest'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptWatcher } from './transcript-watcher'
import { mapClaudeTranscript } from './adapters/claude/transcribe'
import type { AgentEvent } from './adapters/contract'

// Deterministic: no real claude. Verifies the watcher discovers a session file created after
// start, tails appended bytes, and parses each record into events.
describe('TranscriptWatcher', () => {
  it('discovers the session file after start and tails appended records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-'))
    const events: AgentEvent[] = []
    const watcher = new TranscriptWatcher({ dir, map: mapClaudeTranscript }, (e) => events.push(e), 80)
    watcher.start()

    // session file appears after start (claude creates it on first turn, not at spawn)
    await new Promise((r) => setTimeout(r, 200))
    const file = join(dir, 'sess.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'system', sessionId: 's1' }) + '\n')

    await new Promise((r) => setTimeout(r, 200))
    appendFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 1 }
        }
      }) + '\n'
    )

    await new Promise((r) => setTimeout(r, 300))
    watcher.stop()

    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('session-identified')
    expect(kinds).toContain('assistant-text')
    expect(kinds).toContain('usage')
    expect(kinds).toContain('turn-complete')
  }, 6000)
})
