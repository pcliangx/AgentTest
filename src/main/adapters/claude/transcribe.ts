// Claude transcript mapper (pure). Parses one JSONL record from
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl into AgentEvents. This is the structured
// sidecar to the PTY: authoritative (agent-authored) messages + usage + tool calls + session/turn.
import type { AgentEvent } from '../contract'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}
function safeStr(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
function usageEv(u: Record<string, unknown>, at: number): AgentEvent {
  return {
    kind: 'usage',
    occurredAt: at,
    source: 'protocol',
    payload: {
      inputTokens: num(u['input_tokens']),
      outputTokens: num(u['output_tokens']),
      cacheReadTokens: num(u['cache_read_input_tokens']),
      cacheCreationTokens: num(u['cache_creation_input_tokens'])
    }
  }
}

/** Map one Claude transcript record to zero or more AgentEvents. */
export function mapClaudeTranscript(raw: unknown): AgentEvent[] {
  if (!isRecord(raw)) return []
  const type = raw['type']
  const at = Date.now()
  const sessionId = typeof raw['sessionId'] === 'string' ? (raw['sessionId'] as string) : undefined
  const out: AgentEvent[] = []

  if (type === 'system') {
    if (sessionId) out.push({ kind: 'session-identified', occurredAt: at, source: 'protocol', payload: { sessionId } })
    return out
  }

  const message = raw['message']
  if (!isRecord(message)) return out
  const content = message['content']

  if (type === 'assistant') {
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!isRecord(b)) continue
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          out.push({ kind: 'assistant-text', occurredAt: at, source: 'protocol', payload: { text: b['text'] } })
        } else if (b['type'] === 'tool_use') {
          out.push({ kind: 'tool-start', occurredAt: at, source: 'protocol', payload: { tool: b['name'], arg: safeStr(b['input']) } })
        }
      }
    }
    if (isRecord(message['usage'])) out.push(usageEv(message['usage'], at))
    const stop = message['stop_reason']
    if (typeof stop === 'string' && stop.length > 0) {
      out.push({ kind: 'turn-complete', occurredAt: at, source: 'protocol', payload: { stopReason: stop } })
    }
  } else if (type === 'user') {
    // -p transcripts have no 'system' record, so surface the session id from the user record too.
    if (sessionId) out.push({ kind: 'session-identified', occurredAt: at, source: 'protocol', payload: { sessionId } })
    if (Array.isArray(content)) {
      for (const b of content) {
        if (isRecord(b) && b['type'] === 'tool_result') {
          out.push({ kind: 'tool-end', occurredAt: at, source: 'protocol', payload: { status: b['is_error'] ? 'error' : 'ok' } })
        }
      }
    }
  }
  return out
}

/** Encode cwd the way Claude names its projects dir: every non-alphanumeric run -> '-'
 *  (covers /, \, :, space, underscore, etc. — verified against real projects dirs). */
export function claudeProjectDir(cwd: string): string {
  const home = process.env['HOME'] ?? ''
  const enc = cwd.replace(/[^a-zA-Z0-9]+/g, '-')
  return `${home}/.claude/projects/${enc}`
}
