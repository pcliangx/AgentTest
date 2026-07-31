import { describe, it, expect } from 'vitest'
import { mapClaudeTranscript, claudeProjectDir } from './transcribe'
import type { AgentEvent } from '../contract'

const payload = (e: AgentEvent): Record<string, unknown> => e.payload as Record<string, unknown>

describe('mapClaudeTranscript', () => {
  it('emits session-identified from a system record', () => {
    const out = mapClaudeTranscript({ type: 'system', sessionId: 's1' })
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('session-identified')
    expect(payload(out[0]).sessionId).toBe('s1')
  })

  it('maps assistant text + tool_use + usage + turn-complete (stop_reason)', () => {
    const out = mapClaudeTranscript({
      type: 'assistant',
      sessionId: 's1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/a' } }
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 20 }
      }
    })
    expect(out.map((e) => e.kind)).toEqual(['assistant-text', 'tool-start', 'usage', 'turn-complete'])
    expect(payload(out.find((e) => e.kind === 'usage')!).inputTokens).toBe(100)
    expect(payload(out.find((e) => e.kind === 'turn-complete')!).stopReason).toBe('end_turn')
  })

  it('maps user tool_result to tool-end and surfaces session id', () => {
    const out = mapClaudeTranscript({
      type: 'user',
      sessionId: 's1',
      message: { content: [{ type: 'tool_result', is_error: false }] }
    })
    const kinds = out.map((e) => e.kind)
    expect(kinds).toContain('session-identified')
    expect(kinds).toContain('tool-end')
    expect(payload(out.find((e) => e.kind === 'tool-end')!).status).toBe('ok')
  })

  it('drops non-records and unknown types', () => {
    expect(mapClaudeTranscript('x')).toHaveLength(0)
    expect(mapClaudeTranscript({ type: 'whatever' })).toHaveLength(0)
  })
})

describe('claudeProjectDir', () => {
  it('encodes cwd separators into dashes', () => {
    const dir = claudeProjectDir('/Users/foo/Library/Application Support/app/worktrees/claude')
    expect(dir.endsWith('/.claude/projects/-Users-foo-Library-Application-Support-app-worktrees-claude')).toBe(true)
  })

  it('encodes underscores (and other non-alphanumerics) the way Claude does', () => {
    const dir = claudeProjectDir('/private/var/folders/8x/zbvzzwh525lfw_ldp529f4lm0000gn/T/x')
    expect(dir.endsWith('-private-var-folders-8x-zbvzzwh525lfw-ldp529f4lm0000gn-T-x')).toBe(true)
  })
})
