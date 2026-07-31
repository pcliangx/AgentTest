// Run manager — owns one agent run's process lifecycle.
// Spawns the agent CLI, feeds stdout through a per-run BoundedJsonlDecoder, maps raw events via the
// adapter, and reports AgentEvents + exit. Per-run decoder state => safe under concurrent runs.

import { spawn, type ChildProcess } from 'node:child_process'
import { BoundedJsonlDecoder } from './adapters/shared/bounded-jsonl-decoder'
import type { AgentAdapter, AgentEvent } from './adapters/contract'

export interface RunOptions {
  readonly adapter: AgentAdapter
  readonly cwd: string
  readonly text: string
  /** If present, the run resumes this native conversation; otherwise it starts fresh. */
  readonly nativeSessionId?: string
  readonly onEvent: (event: AgentEvent) => void
  readonly onExit: (code: number | null) => void
}

export function startRun(opts: RunOptions): ChildProcess {
  const argv = opts.nativeSessionId
    ? opts.adapter.buildResumeArgv({ text: opts.text, nativeSessionId: opts.nativeSessionId })
    : opts.adapter.buildStartArgv({ text: opts.text })

  const child = spawn(opts.adapter.executable, [...argv], {
    cwd: opts.cwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const decoder = new BoundedJsonlDecoder()

  child.stdout?.on('data', (chunk: Buffer) => {
    const { values, warnings } = decoder.feed(chunk)
    const now = Date.now()
    for (const w of warnings) {
      opts.onEvent({ kind: 'warning', occurredAt: now, source: 'protocol', payload: { message: w } })
    }
    for (const v of values) {
      for (const e of opts.adapter.mapRaw(v)) opts.onEvent(e)
    }
  })

  child.stderr?.on('data', (d: Buffer) => {
    opts.onEvent({
      kind: 'warning',
      occurredAt: Date.now(),
      source: 'protocol',
      payload: { stderr: d.toString('utf8') }
    })
  })

  child.on('error', (err) => {
    opts.onEvent({
      kind: 'error',
      occurredAt: Date.now(),
      source: 'inferred',
      payload: { message: `spawn error: ${err.message}` }
    })
  })

  child.on('exit', (code) => opts.onExit(code))

  return child
}
