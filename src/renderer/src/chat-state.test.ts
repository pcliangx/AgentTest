import { describe, expect, it } from 'vitest'
import { addUserMessage, applyAgentEvent, emptyPaneState } from './chat-state'

describe('structured chat state', () => {
  it('coalesces streamed assistant deltas and tracks tool, usage, and completion', () => {
    let state = addUserMessage(emptyPaneState(), 'hello')
    state = applyAgentEvent(state, {
      kind: 'assistant-text',
      occurredAt: 1,
      source: 'protocol',
      payload: { text: 'hello ' }
    })
    state = applyAgentEvent(state, {
      kind: 'assistant-text',
      occurredAt: 2,
      source: 'protocol',
      payload: { text: 'world' }
    })
    state = applyAgentEvent(state, {
      kind: 'tool-start',
      occurredAt: 3,
      source: 'protocol',
      payload: { id: 'tool-1', tool: 'Read', arg: 'README.md' }
    })
    state = applyAgentEvent(state, {
      kind: 'tool-end',
      occurredAt: 4,
      source: 'protocol',
      payload: { id: 'tool-1', tool: 'Read', status: 'ok' }
    })
    state = applyAgentEvent(state, {
      kind: 'usage',
      occurredAt: 5,
      source: 'protocol',
      payload: { inputTokens: 10, outputTokens: 4 }
    })
    state = applyAgentEvent(state, {
      kind: 'turn-complete',
      occurredAt: 6,
      source: 'protocol',
      payload: {}
    })

    expect(state.status).toBe('finishing')

    state = applyAgentEvent(state, {
      kind: 'process-exited',
      occurredAt: 7,
      source: 'protocol',
      payload: { code: 0, canceled: false }
    })

    expect(state.items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(state.items.find((item) => item.kind === 'assistant')?.text).toBe('hello world')
    expect(state.items.find((item) => item.kind === 'tool')?.status).toBe('ok')
    expect(state.usage).toEqual({ input: 10, output: 4 })
    expect(state.status).toBe('done')
  })

  it('keeps protocol errors terminal even if the protocol also closes the turn', () => {
    let state = addUserMessage(emptyPaneState(), 'fail')
    state = applyAgentEvent(state, {
      kind: 'error',
      occurredAt: 1,
      source: 'protocol',
      payload: { message: 'upstream failed' }
    })
    state = applyAgentEvent(state, {
      kind: 'turn-complete',
      occurredAt: 2,
      source: 'protocol',
      payload: { terminalReason: 'error' }
    })
    state = applyAgentEvent(state, {
      kind: 'process-exited',
      occurredAt: 3,
      source: 'protocol',
      payload: { code: 0, canceled: false }
    })

    expect(state.status).toBe('error')
    expect(state.items.at(-1)?.text).toBe('upstream failed')
  })
})
