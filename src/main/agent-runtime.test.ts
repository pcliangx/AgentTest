import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRuntime } from './agent-runtime'
import { SessionStore } from './session-store'
import { kimiAdapter } from './adapters/kimi/adapter'
import { createCodexEventDecoder } from './adapters/codex/decode'
import type { AgentAdapter, AgentEvent } from './adapters/contract'

function transcriptAwareCli(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenttest-runtime-history-'))
  const script = join(dir, 'history-cli.mjs')
  writeFileSync(
    script,
    `
process.stdin.setEncoding('utf8')
let prompt = ''
process.stdin.on('data', (chunk) => { prompt += chunk })
process.stdin.on('end', () => {
  const hasHistory = prompt.includes('## assistant\\nfirst response')
  const reply = hasHistory ? 'history preserved' : 'first response'
  const write = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
  write({ type: 'turn.started' })
  write({ type: 'item.completed', item: { type: 'agent_message', text: reply } })
  write({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
})
`,
    'utf8'
  )
  return script
}

function nativeResumeCli(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenttest-runtime-resume-'))
  const script = join(dir, 'resume-cli.mjs')
  writeFileSync(
    script,
    `
const resumed = process.argv.includes('native-session-1')
process.stdin.setEncoding('utf8')
let prompt = ''
process.stdin.on('data', (chunk) => { prompt += chunk })
process.stdin.on('end', () => {
  const write = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
  write({ type: 'thread.started', thread_id: 'native-session-1' })
  const cleanLatestTurn = resumed && prompt === 'second question'
  const reply = resumed ? (cleanLatestTurn ? 'native resume used' : 'history was replayed') : 'first response'
  write({ type: 'item.completed', item: { type: 'agent_message', text: reply } })
  write({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
})
`,
    'utf8'
  )
  return script
}

describe('AgentRuntime', () => {
  it('replays completed transcript turns for an adapter without native resume', async () => {
    const script = transcriptAwareCli()
    const adapter: AgentAdapter = {
      ...kimiAdapter,
      executable: process.execPath,
      protocol: {
        kind: 'jsonl',
        promptInput: 'text',
        createDecoder: createCodexEventDecoder
      },
      buildArgv: () => [script]
    }
    const store = new SessionStore(join(mkdtempSync(join(tmpdir(), 'agenttest-session-')), 'sessions.json'))
    const assistantTexts: string[] = []
    let exitWaiter: (() => void) | null = null
    const runtime = new AgentRuntime({
      adapters: [adapter],
      resolveCwd: () => tmpdir(),
      sessionStore: store,
      onEvent: (_target, event: AgentEvent) => {
        if (event.kind === 'assistant-text') {
          assistantTexts.push((event.payload as { text: string }).text)
        }
        if (event.kind === 'process-exited') exitWaiter?.()
      }
    })

    const run = async (text: string): Promise<void> => {
      await new Promise<void>((resolve) => {
        exitWaiter = resolve
        expect(runtime.run('kimi', text)).toEqual({ ok: true })
      })
      exitWaiter = null
    }

    await run('first question')
    await run('second question')

    expect(assistantTexts).toEqual(['first response', 'history preserved'])
    expect(runtime.isRunning('kimi')).toBe(false)
  })

  it('persists a native session id and sends only the latest turn when resuming', async () => {
    const script = nativeResumeCli()
    const adapter: AgentAdapter = {
      ...kimiAdapter,
      conversationMode: 'native-resume',
      executable: process.execPath,
      protocol: {
        kind: 'jsonl',
        promptInput: 'text',
        createDecoder: createCodexEventDecoder
      },
      buildArgv: ({ nativeSessionId }) => [
        script,
        ...(nativeSessionId ? [nativeSessionId] : [])
      ]
    }
    const store = new SessionStore(
      join(mkdtempSync(join(tmpdir(), 'agenttest-native-session-')), 'sessions.json')
    )
    const assistantTexts: string[] = []
    let exitWaiter: (() => void) | null = null
    const runtime = new AgentRuntime({
      adapters: [adapter],
      resolveCwd: () => tmpdir(),
      sessionStore: store,
      onEvent: (_target, event: AgentEvent) => {
        if (event.kind === 'assistant-text') {
          assistantTexts.push((event.payload as { text: string }).text)
        }
        if (event.kind === 'process-exited') exitWaiter?.()
      }
    })

    const run = async (text: string): Promise<void> => {
      await new Promise<void>((resolve) => {
        exitWaiter = resolve
        expect(runtime.run('kimi', text)).toEqual({ ok: true })
      })
      exitWaiter = null
    }

    await run('first question')
    expect(store.getNativeSessionId('kimi')).toBe('native-session-1')
    await run('second question')

    expect(assistantTexts).toEqual(['first response', 'native resume used'])
  })

  it('waits for active structured processes to exit when disposing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenttest-runtime-dispose-'))
    const script = join(dir, 'hanging-cli.mjs')
    writeFileSync(
      script,
      "process.stdin.resume()\nsetInterval(() => {}, 1000)\n",
      'utf8'
    )
    const adapter: AgentAdapter = {
      ...kimiAdapter,
      executable: process.execPath,
      protocol: {
        kind: 'jsonl',
        promptInput: 'text',
        createDecoder: createCodexEventDecoder
      },
      buildArgv: () => [script]
    }
    let exited = false
    const runtime = new AgentRuntime({
      adapters: [adapter],
      resolveCwd: () => tmpdir(),
      sessionStore: new SessionStore(
        join(mkdtempSync(join(tmpdir(), 'agenttest-dispose-session-')), 'sessions.json')
      ),
      onEvent: (_target, event) => {
        if (event.kind === 'process-exited') exited = true
      }
    })

    expect(runtime.run('kimi', 'wait')).toEqual({ ok: true })
    await runtime.disposeAll()

    expect(exited).toBe(true)
    expect(runtime.isRunning('kimi')).toBe(false)
  })
})
