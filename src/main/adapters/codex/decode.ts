import type { AgentEvent, AgentEventDecoder } from '../contract'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function event(kind: AgentEvent['kind'], payload: unknown): AgentEvent {
  return { kind, occurredAt: Date.now(), source: 'protocol', payload }
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

class CodexEventDecoder implements AgentEventDecoder {
  private readonly openTools = new Set<string>()
  private completed = false

  push(raw: unknown): readonly AgentEvent[] {
    if (!isRecord(raw)) return []

    if (raw['type'] === 'thread.started') {
      return typeof raw['thread_id'] === 'string'
        ? [event('session-identified', { sessionId: raw['thread_id'] })]
        : []
    }
    if (raw['type'] === 'turn.started') {
      return [event('status', { status: 'thinking' })]
    }
    if (raw['type'] === 'item.started' && isRecord(raw['item'])) {
      return this.itemStarted(raw['item'])
    }
    if (raw['type'] === 'item.completed' && isRecord(raw['item'])) {
      return this.itemCompleted(raw['item'])
    }
    if (raw['type'] === 'turn.completed') {
      const out: AgentEvent[] = []
      if (isRecord(raw['usage'])) {
        const usage = raw['usage']
        out.push(
          event('usage', {
            inputTokens: number(usage['input_tokens']),
            outputTokens: number(usage['output_tokens']),
            reasoningTokens: number(usage['reasoning_output_tokens']),
            cacheReadTokens: number(usage['cached_input_tokens'])
          })
        )
      }
      if (!this.completed) {
        this.completed = true
        out.push(event('turn-complete', { terminalReason: 'completed' }))
      }
      return out
    }
    if (raw['type'] === 'turn.failed') {
      return [event('error', { message: stringify(raw['error'] ?? raw['message'] ?? 'Codex turn failed') })]
    }
    if (raw['type'] === 'error') {
      const message = stringify(raw['message'] ?? raw['error'] ?? 'Codex error')
      if (/reconnect|timed out|falling back/i.test(message)) {
        return [event('warning', { message })]
      }
      return [event('error', { message })]
    }
    return []
  }

  private itemStarted(item: Record<string, unknown>): AgentEvent[] {
    if (item['type'] !== 'command_execution' || typeof item['id'] !== 'string') return []
    this.openTools.add(item['id'])
    return [
      event('tool-start', {
        id: item['id'],
        tool: 'Bash',
        arg: typeof item['command'] === 'string' ? item['command'] : ''
      })
    ]
  }

  private itemCompleted(item: Record<string, unknown>): AgentEvent[] {
    if (item['type'] === 'agent_message' && typeof item['text'] === 'string') {
      return [event('assistant-text', { text: item['text'] })]
    }
    if (item['type'] === 'reasoning') {
      const text = item['text'] ?? item['content']
      return typeof text === 'string' ? [event('thinking', { text })] : []
    }
    if (item['type'] !== 'command_execution' || typeof item['id'] !== 'string') return []

    const out: AgentEvent[] = []
    if (!this.openTools.has(item['id'])) {
      out.push(
        event('tool-start', {
          id: item['id'],
          tool: 'Bash',
          arg: typeof item['command'] === 'string' ? item['command'] : ''
        })
      )
    }
    this.openTools.delete(item['id'])
    out.push(
      event('tool-end', {
        id: item['id'],
        tool: 'Bash',
        status:
          (typeof item['exit_code'] === 'number' && item['exit_code'] !== 0) ||
          item['status'] === 'failed'
            ? 'error'
            : 'ok',
        content: stringify(item['aggregated_output'] ?? '')
      })
    )
    return out
  }
}

export function createCodexEventDecoder(): AgentEventDecoder {
  return new CodexEventDecoder()
}
