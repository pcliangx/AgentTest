import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRun } from './run-manager'
import { claudeAdapter } from './adapters/claude/adapter'
import { codexAdapter } from './adapters/codex/adapter'
import { kimiAdapter } from './adapters/kimi/adapter'
import type { AgentAdapter, AgentEvent } from './adapters/contract'

function fakeClaudeCli(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenttest-claude-runtime-'))
  const script = join(dir, 'fake-claude.mjs')
  writeFileSync(
    script,
    `
process.stdin.setEncoding('utf8')
let buffer = ''
let handled = false
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const newline = buffer.indexOf('\\n')
  if (handled || newline < 0) return
  handled = true
  const input = JSON.parse(buffer.slice(0, newline))
  const text = input.message.content[0].text
  const messageId = 'message-1'
  const sessionId = 'session-1'
  const write = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
  write({ type: 'system', subtype: 'init', session_id: sessionId })
  write({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: messageId } }
  })
  write({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'echo:' + text }
    }
  })
  write({
    type: 'assistant',
    session_id: sessionId,
    message: {
      id: messageId,
      content: [{ type: 'text', text: 'echo:' + text }],
      stop_reason: 'end_turn'
    },
    parent_tool_use_id: null
  })
})
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    type: 'result',
    session_id: 'session-1',
    is_error: false,
    terminal_reason: 'completed',
    usage: { input_tokens: 3, output_tokens: 2 }
  }) + '\\n')
})
`,
    'utf8'
  )
  return script
}

function fakeCodexCli(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenttest-codex-runtime-'))
  const script = join(dir, 'fake-codex.mjs')
  writeFileSync(
    script,
    `
process.stdin.setEncoding('utf8')
let prompt = ''
process.stdin.on('data', (chunk) => { prompt += chunk })
process.stdin.on('end', () => {
  const write = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
  write({ type: 'thread.started', thread_id: 'thread-1' })
  write({ type: 'turn.started' })
  write({
    type: 'item.completed',
    item: { id: 'message-1', type: 'agent_message', text: 'echo:' + prompt }
  })
  write({
    type: 'turn.completed',
    usage: { input_tokens: 4, output_tokens: 2, cached_input_tokens: 1 }
  })
})
`,
    'utf8'
  )
  return script
}

function fakeKimiAcpCli(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenttest-kimi-runtime-'))
  const script = join(dir, 'fake-kimi-acp.mjs')
  writeFileSync(
    script,
    `
process.stdin.setEncoding('utf8')
let buffer = ''
let promptRequest = null
const write = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
function handle(message) {
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
    return
  }
  if (message.method === 'session/new') {
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'acp-session-1' } })
    return
  }
  if (message.method === 'session/prompt') {
    promptRequest = message
    write({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: { options: [{ optionId: 'once', kind: 'allow_once' }] }
    })
    return
  }
  if (message.id === 99 && message.result?.outcome?.optionId === 'once') {
    const text = promptRequest.params.prompt[0].text
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'echo:' + text }
        }
      }
    })
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          kind: 'read',
          title: 'read file',
          status: 'completed',
          locations: [{ path: 'README.md' }]
        }
      }
    })
    write({
      jsonrpc: '2.0',
      id: promptRequest.id,
      result: { usage: { inputTokens: 5, outputTokens: 2 } }
    })
  }
}
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) handle(JSON.parse(line))
    newline = buffer.indexOf('\\n')
  }
})
`,
    'utf8'
  )
  return script
}

function scriptWithBody(prefix: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const script = join(dir, 'cli.mjs')
  writeFileSync(script, body, 'utf8')
  return script
}

function payload(event: AgentEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>
}

describe('startRun structured transport', () => {
  it('streams a Claude JSONL turn through stdin without duplicating the final assistant wrapper', async () => {
    const script = fakeClaudeCli()
    const adapter: AgentAdapter = {
      ...claudeAdapter,
      executable: process.execPath,
      buildArgv: () => [script]
    }
    const events: AgentEvent[] = []

    await new Promise<void>((resolve) => {
      startRun({
        adapter,
        cwd: tmpdir(),
        text: 'hello',
        onEvent: (event) => events.push(event),
        onExit: () => resolve()
      })
    })

    expect(
      events.filter((event) => event.kind === 'assistant-text').map((event) => payload(event).text)
    ).toEqual(['echo:hello'])
    expect(
      events.find((event) => event.kind === 'session-identified')?.payload
    ).toEqual({ sessionId: 'session-1' })
    expect(events.filter((event) => event.kind === 'turn-complete')).toHaveLength(1)
    expect(payload(events.find((event) => event.kind === 'usage')!).inputTokens).toBe(3)
  })

  it('streams a Codex JSONL turn and captures its generated thread id', async () => {
    const script = fakeCodexCli()
    const adapter: AgentAdapter = {
      ...codexAdapter,
      executable: process.execPath,
      buildArgv: () => [script]
    }
    const events: AgentEvent[] = []

    await new Promise<void>((resolve) => {
      startRun({
        adapter,
        cwd: tmpdir(),
        text: 'hello codex',
        onEvent: (event) => events.push(event),
        onExit: () => resolve()
      })
    })

    expect(payload(events.find((event) => event.kind === 'assistant-text')!).text).toBe(
      'echo:hello codex'
    )
    expect(events.find((event) => event.kind === 'session-identified')?.payload).toEqual({
      sessionId: 'thread-1'
    })
    expect(events.filter((event) => event.kind === 'turn-complete')).toHaveLength(1)
    expect(payload(events.find((event) => event.kind === 'usage')!).cacheReadTokens).toBe(1)
  })

  it('drives a Kimi ACP turn including permission response, tools, usage, and completion', async () => {
    const script = fakeKimiAcpCli()
    const adapter: AgentAdapter = {
      ...kimiAdapter,
      executable: process.execPath,
      buildArgv: () => [script]
    }
    const events: AgentEvent[] = []

    await new Promise<void>((resolve) => {
      startRun({
        adapter,
        cwd: tmpdir(),
        text: 'hello kimi',
        onEvent: (event) => events.push(event),
        onExit: () => resolve()
      })
    })

    expect(payload(events.find((event) => event.kind === 'assistant-text')!).text).toBe(
      'echo:hello kimi'
    )
    expect(events.filter((event) => event.kind === 'tool-start')).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'tool-end')).toHaveLength(1)
    expect(payload(events.find((event) => event.kind === 'usage')!).inputTokens).toBe(5)
    expect(events.filter((event) => event.kind === 'turn-complete')).toHaveLength(1)
  })

  it('reports a protocol error when a CLI exits cleanly before completing a turn', async () => {
    const script = scriptWithBody('agenttest-early-exit-', 'process.exit(0)\n')
    const adapter: AgentAdapter = {
      ...codexAdapter,
      executable: process.execPath,
      buildArgv: () => [script]
    }
    const events: AgentEvent[] = []

    await new Promise<void>((resolve) => {
      startRun({
        adapter,
        cwd: tmpdir(),
        text: 'hello',
        onEvent: (event) => events.push(event),
        onExit: () => resolve()
      })
    })

    expect(events.filter((event) => event.kind === 'error')).toHaveLength(1)
  })

  it('marks user cancellation without inventing a protocol failure', async () => {
    const script = scriptWithBody(
      'agenttest-cancel-',
      "process.stdin.resume()\nsetInterval(() => {}, 1000)\n"
    )
    const adapter: AgentAdapter = {
      ...claudeAdapter,
      executable: process.execPath,
      buildArgv: () => [script]
    }
    const events: AgentEvent[] = []

    await new Promise<void>((resolve) => {
      const run = startRun({
        adapter,
        cwd: tmpdir(),
        text: 'hello',
        onEvent: (event) => events.push(event),
        onExit: () => resolve()
      })
      setTimeout(() => run.cancel(), 20)
    })

    expect(events.filter((event) => event.kind === 'error')).toHaveLength(0)
    expect(
      payload(events.find((event) => event.kind === 'process-exited')!).canceled
    ).toBe(true)
  })

  it('fails an ACP handshake that stops making protocol progress', async () => {
    const script = scriptWithBody(
      'agenttest-acp-timeout-',
      "process.stdin.resume()\nsetInterval(() => {}, 1000)\n"
    )
    const adapter: AgentAdapter = {
      ...kimiAdapter,
      executable: process.execPath,
      protocol: { kind: 'acp-json-rpc', stageTimeoutMs: 30 },
      buildArgv: () => [script]
    }
    const events: AgentEvent[] = []

    await new Promise<void>((resolve) => {
      startRun({
        adapter,
        cwd: tmpdir(),
        text: 'hello',
        onEvent: (event) => events.push(event),
        onExit: () => resolve()
      })
    })

    expect(
      String(payload(events.find((event) => event.kind === 'error')!).message)
    ).toContain('timed out')
  })
})
