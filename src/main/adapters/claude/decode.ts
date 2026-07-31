// Claude Code stream-json event mapper (pure, stateless).
// Shapes derived from the 2026-07-31 probe — see fixtures/sample.jsonl and ../PROBE.md.
// Hook/plugin noise is dropped here; --bare at launch prevents most of it from being emitted at all.

import type { AgentEvent } from '../contract'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function usageEvent(usage: Record<string, unknown>, occurredAt: number): AgentEvent {
  return {
    kind: 'usage',
    occurredAt,
    source: 'protocol',
    payload: {
      inputTokens: num(usage['input_tokens']),
      outputTokens: num(usage['output_tokens']),
      cacheReadTokens: num(usage['cache_read_input_tokens']),
      cacheCreationTokens: num(usage['cache_creation_input_tokens'])
    }
  }
}

/** Map one parsed Claude Code stream-json event to zero or more AgentEvents. */
export function mapClaudeEvent(raw: unknown): AgentEvent[] {
  if (!isRecord(raw)) return []
  const type = raw['type']
  const occurredAt = Date.now()
  const sessionId = typeof raw['session_id'] === 'string' ? (raw['session_id'] as string) : undefined
  const out: AgentEvent[] = []

  switch (type) {
    case 'system': {
      // init carries the session id; hook_* are noise -> drop.
      if (raw['subtype'] === 'init' && sessionId) {
        out.push({ kind: 'session-identified', occurredAt, source: 'protocol', payload: { sessionId } })
      }
      break
    }
    case 'assistant': {
      const message = raw['message']
      if (isRecord(message)) {
        const content = message['content']
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!isRecord(block)) continue
            if (block['type'] === 'text' && typeof block['text'] === 'string') {
              out.push({ kind: 'assistant-text', occurredAt, source: 'protocol', payload: { text: block['text'] } })
            } else if (block['type'] === 'tool_use') {
              out.push({
                kind: 'tool-start',
                occurredAt,
                source: 'protocol',
                payload: { tool: block['name'], arg: safeStringify(block['input']) }
              })
            }
          }
        }
        if (isRecord(message['usage'])) out.push(usageEvent(message['usage'], occurredAt))
      }
      break
    }
    case 'user': {
      // tool_result blocks arrive as user messages.
      const message = raw['message']
      if (isRecord(message) && Array.isArray(message['content'])) {
        for (const block of message['content']) {
          if (isRecord(block) && block['type'] === 'tool_result') {
            out.push({
              kind: 'tool-end',
              occurredAt,
              source: 'protocol',
              payload: { tool: block['name'] ?? 'tool', status: block['is_error'] ? 'error' : 'ok' }
            })
          }
        }
      }
      break
    }
    case 'result': {
      if (isRecord(raw['usage'])) out.push(usageEvent(raw['usage'], occurredAt))
      out.push({
        kind: 'turn-complete',
        occurredAt,
        source: 'protocol',
        payload: {
          terminalReason: raw['terminal_reason'] ?? null,
          result: typeof raw['result'] === 'string' ? raw['result'] : null
        }
      })
      if (sessionId) out.push({ kind: 'session-identified', occurredAt, source: 'protocol', payload: { sessionId } })
      break
    }
    default: {
      if (type === 'error' || raw['is_error'] === true) {
        out.push({
          kind: 'error',
          occurredAt,
          source: 'protocol',
          payload: { message: raw['message'] ?? raw['result'] ?? 'unknown error' }
        })
      }
      // unknown event types -> drop
    }
  }

  return out
}
