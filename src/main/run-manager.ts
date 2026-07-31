// Run manager — owns one structured agent process for one turn.
// Vendor differences stay behind the adapter protocol declaration.

import { spawn, type ChildProcess } from 'node:child_process'
import { BoundedJsonlDecoder } from './adapters/shared/bounded-jsonl-decoder'
import type { AgentAdapter, AgentEvent } from './adapters/contract'
import { attachAcpSession, type AcpSessionController } from './protocols/acp-session'

export interface RunOptions {
  readonly adapter: AgentAdapter
  readonly cwd: string
  readonly text: string
  /** If present, the run resumes this native conversation; otherwise it starts fresh. */
  readonly nativeSessionId?: string
  readonly onEvent: (event: AgentEvent) => void
  readonly onExit: (
    code: number | null,
    outcome: { readonly canceled: boolean }
  ) => void
}

export interface AgentRunHandle {
  readonly child: ChildProcess
  /** Resolves after onExit and the final process-exited event have been delivered. */
  readonly finished: Promise<void>
  cancel(): void
}

function processSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.killed) return
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal)
    } else {
      child.kill(signal)
    }
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Process already exited.
    }
  }
}

export function startRun(opts: RunOptions): AgentRunHandle {
  const argv = opts.adapter.buildArgv({
    cwd: opts.cwd,
    ...(opts.nativeSessionId ? { nativeSessionId: opts.nativeSessionId } : {})
  })

  const child = spawn(opts.adapter.executable, [...argv], {
    cwd: opts.cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32'
  })

  let exited = false
  let turnCompleted = false
  let cancelRequested = false
  let errorEmitted = false
  let acpSession: AcpSessionController | null = null
  let resolveFinished!: () => void
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve
  })
  const forceTimers: NodeJS.Timeout[] = []
  const emit = (event: AgentEvent): void => {
    if (event.kind === 'error') errorEmitted = true
    if (event.kind === 'turn-complete' && !turnCompleted) {
      turnCompleted = true
      if (
        opts.adapter.protocol.kind === 'jsonl' &&
        opts.adapter.protocol.promptInput === 'claude-stream-json' &&
        child.stdin &&
        !child.stdin.destroyed
      ) {
        child.stdin.end()
      }
    }
    opts.onEvent(event)
  }

  const emitDecoded = (
    values: readonly unknown[],
    warnings: readonly string[],
    decode: (value: unknown) => readonly AgentEvent[]
  ): void => {
    const now = Date.now()
    for (const warning of warnings) {
      emit({
        kind: 'warning',
        occurredAt: now,
        source: 'protocol',
        payload: { message: warning }
      })
    }
    for (const value of values) {
      for (const event of decode(value)) emit(event)
    }
  }

  if (opts.adapter.protocol.kind === 'jsonl') {
    const decoder = new BoundedJsonlDecoder()
    const eventDecoder = opts.adapter.protocol.createDecoder()
    child.stdout?.on('data', (chunk: Buffer) => {
      const decoded = decoder.feed(chunk)
      emitDecoded(decoded.values, decoded.warnings, (value) => eventDecoder.push(value))
    })
    child.stdout?.on('end', () => {
      const decoded = decoder.flush()
      emitDecoded(decoded.values, decoded.warnings, (value) => eventDecoder.push(value))
    })

    if (opts.adapter.protocol.promptInput === 'claude-stream-json') {
      const message = {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: opts.text }]
        }
      }
      child.stdin?.write(`${JSON.stringify(message)}\n`, 'utf8')
    } else {
      child.stdin?.end(opts.text, 'utf8')
    }
  } else {
    acpSession = attachAcpSession({
      child,
      prompt: opts.text,
      cwd: opts.cwd,
      onEvent: emit,
      ...(opts.adapter.protocol.stageTimeoutMs
        ? { stageTimeoutMs: opts.adapter.protocol.stageTimeoutMs }
        : {})
    })
  }

  child.stderr?.on('data', (d: Buffer) => {
    emit({
      kind: 'warning',
      occurredAt: Date.now(),
      source: 'protocol',
      payload: { stderr: d.toString('utf8') }
    })
  })

  child.on('error', (err) => {
    emit({
      kind: 'error',
      occurredAt: Date.now(),
      source: 'inferred',
      payload: { message: `spawn error: ${err.message}` }
    })
  })

  child.on('close', (code, signal) => {
    if (exited) return
    exited = true
    for (const timer of forceTimers) clearTimeout(timer)
    if (!turnCompleted && !cancelRequested && !errorEmitted) {
      emit({
        kind: 'error',
        occurredAt: Date.now(),
        source: 'inferred',
        payload: { message: 'Agent process exited before the turn completed' }
      })
    }
    opts.onExit(code, { canceled: cancelRequested })
    emit({
      kind: 'process-exited',
      occurredAt: Date.now(),
      source: 'protocol',
      payload: { code, signal, canceled: cancelRequested }
    })
    resolveFinished()
  })

  return {
    child,
    finished,
    cancel() {
      if (exited || cancelRequested) return
      cancelRequested = true
      if (acpSession) {
        acpSession.abort()
        const termTimer = setTimeout(() => processSignal(child, 'SIGTERM'), 750)
        const killTimer = setTimeout(() => processSignal(child, 'SIGKILL'), 2_500)
        termTimer.unref()
        killTimer.unref()
        forceTimers.push(termTimer, killTimer)
      } else {
        child.stdin?.end()
        processSignal(child, 'SIGTERM')
        const timer = setTimeout(() => processSignal(child, 'SIGKILL'), 2_000)
        timer.unref()
        forceTimers.push(timer)
      }
    }
  }
}
