import type { ChildProcess } from 'node:child_process'
import { BoundedJsonlDecoder } from '../adapters/shared/bounded-jsonl-decoder'
import type { AgentEvent } from '../adapters/contract'
import { APP_TECHNICAL_NAME } from '../app-identity'

interface AcpSessionOptions {
  readonly child: ChildProcess
  readonly prompt: string
  readonly cwd: string
  readonly onEvent: (event: AgentEvent) => void
  readonly stageTimeoutMs?: number
}

export interface AcpSessionController {
  abort(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function event(kind: AgentEvent['kind'], payload: unknown): AgentEvent {
  return { kind, occurredAt: Date.now(), source: 'protocol', payload }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function textFrom(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''
  if (typeof value['text'] === 'string') return value['text']
  if ('content' in value) return textFrom(value['content'])
  return ''
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function permissionOption(options: unknown): string | null {
  const values = Array.isArray(options) ? options.filter(isRecord) : []
  const session = values.find((option) => option['optionId'] === 'approve_for_session')
  if (session) return 'approve_for_session'
  const always = values.find((option) => option['kind'] === 'allow_always')
  if (always && typeof always['optionId'] === 'string') return always['optionId']
  const once = values.find((option) => option['kind'] === 'allow_once')
  return once && typeof once['optionId'] === 'string' ? once['optionId'] : null
}

function acpToolName(update: Record<string, unknown>): string {
  switch (update['kind']) {
    case 'read':
      return 'Read'
    case 'edit':
      return 'Edit'
    case 'write':
      return 'Write'
    case 'execute':
    case 'shell':
    case 'bash':
      return 'Bash'
    case 'search':
      return 'Search'
    default: {
      const candidate = update['name'] ?? update['title']
      return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : 'Tool'
    }
  }
}

function toolArgument(update: Record<string, unknown>): string {
  if (update['rawInput'] !== undefined) return safeStringify(update['rawInput'])
  const locations = update['locations']
  if (Array.isArray(locations)) {
    const paths = locations
      .filter(isRecord)
      .map((location) => location['path'])
      .filter((path): path is string => typeof path === 'string')
    if (paths.length > 0) return paths.join(', ')
  }
  return ''
}

export function attachAcpSession(options: AcpSessionOptions): AcpSessionController {
  const { child, prompt, cwd, onEvent, stageTimeoutMs = 30_000 } = options
  if (!child.stdin || !child.stdout) {
    throw new Error('ACP process requires piped stdin and stdout')
  }

  const stdin = child.stdin
  const decoder = new BoundedJsonlDecoder()
  const openTools = new Set<string>()
  let sessionId: string | null = null
  let promptRequestId: number | null = null
  let nextId = 1
  let emittedText = ''
  let finished = false
  let aborted = false
  let stageTimer: ReturnType<typeof setTimeout> | null = null

  const clearStageTimer = (): void => {
    if (stageTimer) clearTimeout(stageTimer)
    stageTimer = null
  }

  const resetStageTimer = (stage: string): void => {
    clearStageTimer()
    stageTimer = setTimeout(() => fail(`ACP ${stage} timed out after ${stageTimeoutMs}ms`), stageTimeoutMs)
    stageTimer.unref()
  }

  const send = (id: number, method: string, params: unknown): void => {
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  }

  const finishTransport = (): void => {
    clearStageTimer()
    if (!stdin.destroyed && !stdin.writableEnded) stdin.end()
    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGTERM')
    }, 500)
    timer.unref()
    child.once('close', () => clearTimeout(timer))
  }

  const fail = (message: string): void => {
    if (finished) return
    finished = true
    onEvent(event('error', { message }))
    finishTransport()
  }

  const sendPrompt = (): void => {
    if (!sessionId) {
      fail('ACP session/new did not return a sessionId')
      return
    }
    promptRequestId = nextId
    send(nextId, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }]
    })
    nextId += 1
    onEvent(event('status', { status: 'working' }))
    resetStageTimer('session/prompt')
  }

  const emitUsage = (usage: unknown): void => {
    if (!isRecord(usage)) return
    onEvent(
      event('usage', {
        inputTokens: finiteNumber(usage['inputTokens'] ?? usage['input_tokens']),
        outputTokens: finiteNumber(usage['outputTokens'] ?? usage['output_tokens']),
        cacheReadTokens: finiteNumber(
          usage['cachedReadTokens'] ?? usage['cached_read_tokens']
        )
      })
    )
  }

  const handleToolUpdate = (update: Record<string, unknown>): void => {
    const id =
      typeof update['toolCallId'] === 'string'
        ? update['toolCallId']
        : typeof update['id'] === 'string'
          ? update['id']
          : null
    if (!id) return
    const name = acpToolName(update)
    if (!openTools.has(id)) {
      openTools.add(id)
      onEvent(event('tool-start', { id, tool: name, arg: toolArgument(update) }))
    }
    const status = update['status']
    if (!['completed', 'failed', 'error', 'cancelled'].includes(String(status))) return
    openTools.delete(id)
    onEvent(
      event('tool-end', {
        id,
        tool: name,
        status: status === 'completed' ? 'ok' : 'error',
        content: textFrom(update['content'] ?? update['rawOutput'])
      })
    )
  }

  const handleUpdate = (update: Record<string, unknown>): void => {
    if (update['sessionUpdate'] === 'agent_message_chunk') {
      const text = textFrom(update['content'])
      if (!text) return
      const delta = text.startsWith(emittedText) ? text.slice(emittedText.length) : text
      if (!delta) return
      emittedText += delta
      onEvent(event('assistant-text', { text: delta }))
      return
    }
    if (update['sessionUpdate'] === 'agent_thought_chunk') {
      const text = textFrom(update['content'])
      if (text) onEvent(event('thinking', { text }))
      return
    }
    if (
      update['sessionUpdate'] === 'tool_call' ||
      update['sessionUpdate'] === 'tool_call_update'
    ) {
      handleToolUpdate(update)
    }
  }

  const handle = (raw: unknown): void => {
    if (finished || !isRecord(raw)) return
    resetStageTimer('response')
    if (isRecord(raw['error'])) {
      fail(
        typeof raw['error']['message'] === 'string'
          ? raw['error']['message']
          : 'ACP JSON-RPC error'
      )
      return
    }
    if (raw['method'] === 'session/request_permission') {
      const params = isRecord(raw['params']) ? raw['params'] : {}
      const optionId = permissionOption(params['options'])
      if (!optionId || (typeof raw['id'] !== 'number' && typeof raw['id'] !== 'string')) {
        fail('ACP permission request had no approvable option')
        return
      }
      stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: raw['id'],
          result: { outcome: { outcome: 'selected', optionId } }
        })}\n`
      )
      return
    }
    if (raw['method'] === 'session/update') {
      const params = isRecord(raw['params']) ? raw['params'] : null
      const update = params && isRecord(params['update']) ? params['update'] : null
      if (update) handleUpdate(update)
      return
    }
    if (!isRecord(raw['result'])) return

    if (raw['id'] === 1) {
      send(2, 'session/new', { cwd, mcpServers: [] })
      nextId = 3
      resetStageTimer('session/new')
      return
    }
    if (raw['id'] === 2) {
      sessionId =
        typeof raw['result']['sessionId'] === 'string' ? raw['result']['sessionId'] : null
      sendPrompt()
      return
    }
    if (promptRequestId !== null && raw['id'] === promptRequestId) {
      emitUsage(raw['result']['usage'])
      finished = true
      onEvent(event('turn-complete', { terminalReason: 'completed' }))
      finishTransport()
    }
  }

  child.stdout.on('data', (chunk: Buffer) => {
    const decoded = decoder.feed(chunk)
    for (const warning of decoded.warnings) {
      onEvent(event('warning', { message: warning }))
    }
    for (const value of decoded.values) handle(value)
  })
  child.stdout.on('end', () => {
    const decoded = decoder.flush()
    for (const warning of decoded.warnings) {
      onEvent(event('warning', { message: warning }))
    }
    for (const value of decoded.values) handle(value)
  })

  send(1, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: { terminal: false },
    clientInfo: { name: APP_TECHNICAL_NAME, version: '0.1.0' }
  })
  nextId = 2
  resetStageTimer('initialize')

  return {
    abort() {
      if (finished || aborted) return
      aborted = true
      finished = true
      if (sessionId) {
        send(nextId, 'session/cancel', { sessionId })
        nextId += 1
      }
      finishTransport()
    }
  }
}
