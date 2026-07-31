import { describe, it, expect } from 'vitest'
import { mapClaudeEvent } from './decode'
import type { AgentEvent } from '../contract'

const payload = (e: AgentEvent): Record<string, unknown> => e.payload as Record<string, unknown>

describe('mapClaudeEvent', () => {
  it('emits session-identified from system/init', () => {
    const out = mapClaudeEvent({ type: 'system', subtype: 'init', session_id: 's1', tools: [] })
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('session-identified')
    expect(payload(out[0]).sessionId).toBe('s1')
  })

  it('drops hook noise (hook_started / hook_response)', () => {
    expect(mapClaudeEvent({ type: 'system', subtype: 'hook_started', session_id: 's1' })).toHaveLength(0)
    expect(mapClaudeEvent({ type: 'system', subtype: 'hook_response', session_id: 's1' })).toHaveLength(0)
  })

  it('maps assistant text, tool_use, and usage', () => {
    const out = mapClaudeEvent({
      type: 'assistant',
      session_id: 's1',
      message: {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/a' } }
        ],
        usage: { input_tokens: 10, output_tokens: 2 }
      }
    })
    expect(out.map((e) => e.kind)).toEqual(['assistant-text', 'tool-start', 'usage'])
    expect(payload(out.find((e) => e.kind === 'tool-start')!).tool).toBe('Read')
  })

  it('maps user tool_result to tool-end', () => {
    const out = mapClaudeEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', name: 'Read', is_error: false }] }
    })
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('tool-end')
    expect(payload(out[0]).status).toBe('ok')
  })

  it('maps result to usage + turn-complete + session-identified', () => {
    const out = mapClaudeEvent({
      type: 'result',
      session_id: 's1',
      usage: { input_tokens: 5, output_tokens: 1 },
      terminal_reason: 'completed',
      result: 'done'
    })
    expect(out.map((e) => e.kind)).toEqual(['usage', 'turn-complete', 'session-identified'])
    expect(payload(out.find((e) => e.kind === 'turn-complete')!).terminalReason).toBe('completed')
  })

  it('maps error events', () => {
    const out = mapClaudeEvent({ type: 'error', message: 'boom' })
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('error')
    expect(payload(out[0]).message).toBe('boom')
  })

  it('drops unknown event types', () => {
    expect(mapClaudeEvent({ type: 'whatever', foo: 1 })).toHaveLength(0)
    expect(mapClaudeEvent('not an object')).toHaveLength(0)
  })
})
