// Stateful Claude Code stream-json decoder.
// One decoder belongs to one run so partial-message bookkeeping never leaks across runs.

import type { AgentEvent, AgentEventDecoder } from '../contract'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function event(kind: AgentEvent['kind'], payload: unknown): AgentEvent {
  return { kind, occurredAt: Date.now(), source: 'protocol', payload }
}

function usageEvent(usage: Record<string, unknown>): AgentEvent {
  return event('usage', {
    inputTokens: num(usage['input_tokens']),
    outputTokens: num(usage['output_tokens']),
    cacheReadTokens: num(usage['cache_read_input_tokens']),
    cacheCreationTokens: num(usage['cache_creation_input_tokens'])
  })
}

interface StreamBlock {
  readonly type: unknown
  readonly id: unknown
  readonly name: unknown
  input: string
  readonly initialInput: unknown
}

class ClaudeEventDecoder implements AgentEventDecoder {
  private currentMessageId: string | null = null
  private readonly streamedTextMessages = new Set<string>()
  private readonly streamedThinkingMessages = new Set<string>()
  private readonly emittedToolIds = new Set<string>()
  private readonly blocks = new Map<number, StreamBlock>()
  private readonly seenSessionIds = new Set<string>()
  private completed = false

  push(raw: unknown): readonly AgentEvent[] {
    if (!isRecord(raw)) return []
    const type = raw['type']

    if (type === 'system') return this.system(raw)
    if (type === 'stream_event' && isRecord(raw['event'])) {
      return this.streamEvent(raw['event'])
    }
    if (type === 'assistant') return this.assistant(raw)
    if (type === 'user') return this.user(raw)
    if (type === 'result') return this.result(raw)
    if (type === 'error' || raw['is_error'] === true) {
      return [event('error', { message: raw['message'] ?? raw['result'] ?? 'Claude run failed' })]
    }
    return []
  }

  private session(sessionId: unknown): AgentEvent[] {
    if (
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      this.seenSessionIds.has(sessionId)
    ) {
      return []
    }
    this.seenSessionIds.add(sessionId)
    return [event('session-identified', { sessionId })]
  }

  private system(raw: Record<string, unknown>): AgentEvent[] {
    if (raw['subtype'] === 'init') {
      return this.session(raw['session_id'])
    }
    if (raw['subtype'] === 'status') {
      return [event('status', { status: raw['status'] ?? 'working' })]
    }
    return []
  }

  private streamEvent(raw: Record<string, unknown>): AgentEvent[] {
    if (raw['type'] === 'message_start') {
      const message = raw['message']
      this.currentMessageId =
        isRecord(message) && typeof message['id'] === 'string' ? message['id'] : null
      return []
    }

    if (raw['type'] === 'content_block_start' && isRecord(raw['content_block'])) {
      const index = typeof raw['index'] === 'number' ? raw['index'] : 0
      const block = raw['content_block']
      this.blocks.set(index, {
        type: block['type'],
        id: block['id'],
        name: block['name'],
        input: '',
        initialInput: block['input']
      })
      return []
    }

    if (raw['type'] === 'content_block_delta' && isRecord(raw['delta'])) {
      const delta = raw['delta']
      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        if (this.currentMessageId) this.streamedTextMessages.add(this.currentMessageId)
        return [event('assistant-text', { text: delta['text'] })]
      }
      if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
        if (this.currentMessageId) this.streamedThinkingMessages.add(this.currentMessageId)
        return [event('thinking', { text: delta['thinking'] })]
      }
      if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
        const index = typeof raw['index'] === 'number' ? raw['index'] : 0
        const block = this.blocks.get(index)
        if (block) block.input += delta['partial_json']
      }
      return []
    }

    if (raw['type'] === 'content_block_stop') {
      const index = typeof raw['index'] === 'number' ? raw['index'] : 0
      const block = this.blocks.get(index)
      this.blocks.delete(index)
      if (!block || block.type !== 'tool_use' || typeof block.id !== 'string') return []
      if (this.emittedToolIds.has(block.id)) return []
      let input = block.initialInput
      if (block.input.trim()) {
        try {
          input = JSON.parse(block.input)
        } catch {
          input = block.input
        }
      }
      this.emittedToolIds.add(block.id)
      return [
        event('tool-start', {
          id: block.id,
          tool: typeof block.name === 'string' ? block.name : 'tool',
          arg: safeStringify(input)
        })
      ]
    }

    if (raw['type'] === 'message_delta' && isRecord(raw['usage'])) {
      return [usageEvent(raw['usage'])]
    }
    return []
  }

  private assistant(raw: Record<string, unknown>): AgentEvent[] {
    const message = raw['message']
    if (!isRecord(message)) return []
    const messageId =
      typeof message['id'] === 'string' ? message['id'] : this.currentMessageId
    if (messageId) this.currentMessageId = messageId
    const out: AgentEvent[] = []
    const content = message['content']
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue
        if (
          block['type'] === 'text' &&
          typeof block['text'] === 'string' &&
          (!messageId || !this.streamedTextMessages.has(messageId))
        ) {
          out.push(event('assistant-text', { text: block['text'] }))
        } else if (
          block['type'] === 'thinking' &&
          typeof block['thinking'] === 'string' &&
          (!messageId || !this.streamedThinkingMessages.has(messageId))
        ) {
          out.push(event('thinking', { text: block['thinking'] }))
        } else if (block['type'] === 'tool_use') {
          const blockId = typeof block['id'] === 'string' ? block['id'] : null
          if (!blockId || !this.emittedToolIds.has(blockId)) {
            if (blockId) this.emittedToolIds.add(blockId)
            out.push(
              event('tool-start', {
                ...(blockId ? { id: blockId } : {}),
                tool: typeof block['name'] === 'string' ? block['name'] : 'tool',
                arg: safeStringify(block['input'])
              })
            )
          }
        }
      }
    }
    if (isRecord(message['usage'])) out.push(usageEvent(message['usage']))

    const stopReason = message['stop_reason']
    if (
      raw['parent_tool_use_id'] == null &&
      typeof stopReason === 'string' &&
      stopReason !== 'tool_use' &&
      !this.completed
    ) {
      this.completed = true
      out.push(event('turn-complete', { terminalReason: stopReason }))
    }
    return out
  }

  private user(raw: Record<string, unknown>): AgentEvent[] {
    const message = raw['message']
    if (!isRecord(message) || !Array.isArray(message['content'])) return []
    const out: AgentEvent[] = []
    for (const block of message['content']) {
      if (!isRecord(block) || block['type'] !== 'tool_result') continue
      out.push(
        event('tool-end', {
          id: block['tool_use_id'],
          tool: block['name'] ?? 'tool',
          status: block['is_error'] ? 'error' : 'ok'
        })
      )
    }
    return out
  }

  private result(raw: Record<string, unknown>): AgentEvent[] {
    const out: AgentEvent[] = []
    if (isRecord(raw['usage'])) out.push(usageEvent(raw['usage']))
    if (raw['is_error'] === true) {
      out.push(
        event('error', {
          message: raw['result'] ?? raw['errors'] ?? raw['subtype'] ?? 'Claude run failed'
        })
      )
    }
    if (!this.completed) {
      this.completed = true
      out.push(
        event('turn-complete', {
          terminalReason: raw['terminal_reason'] ?? raw['stop_reason'] ?? null,
          result: typeof raw['result'] === 'string' ? raw['result'] : null
        })
      )
    }
    out.push(...this.session(raw['session_id']))
    return out
  }
}

export function createClaudeEventDecoder(): AgentEventDecoder {
  return new ClaudeEventDecoder()
}

/** Compatibility helper for isolated fixture tests. Stateful runs use createClaudeEventDecoder(). */
export function mapClaudeEvent(raw: unknown): AgentEvent[] {
  return [...createClaudeEventDecoder().push(raw)]
}
