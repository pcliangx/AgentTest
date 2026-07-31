// Run manager — owns one agent run's process lifecycle.
//
// Phase 0: spawns a DUMMY node script (scripts/dummy-agent.mjs) that emits fake AgentEvent-shaped
// JSONL. This proves the spawn → stdout → bounded decode → IPC → pane pipeline end-to-end before
// any real adapter exists.
//
// Phase 1 replaces startDummyRun with a version that takes an AgentAdapter from the registry and
// spawns the real CLI (claude -p --output-format stream-json ...). The seam is already here.

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { BoundedJsonlDecoder } from './adapters/shared/bounded-jsonl-decoder'
import type { AgentEvent, AgentEventKind } from './adapters/contract'

export interface DummyRunOptions {
  readonly target: string
  readonly cwd: string
  readonly onEvent: (event: AgentEvent) => void
  readonly onExit: (code: number | null) => void
}

export function startDummyRun(opts: DummyRunOptions): ChildProcess {
  const script = join(opts.cwd, 'scripts', 'dummy-agent.mjs')
  // ELECTRON_RUN_AS_NODE runs the bundled Node on the script instead of launching another window.
  const child = spawn(process.execPath, [script, opts.target], {
    cwd: opts.cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const decoder = new BoundedJsonlDecoder()

  child.stdout?.on('data', (chunk: Buffer) => {
    const { values, warnings } = decoder.feed(chunk)
    const now = Date.now()
    for (const w of warnings) {
      opts.onEvent({ kind: 'warning', occurredAt: now, source: 'protocol', payload: { message: w } })
    }
    for (const v of values) opts.onEvent(normalize(v, now))
  })

  child.stderr?.on('data', (d: Buffer) => {
    opts.onEvent({
      kind: 'warning',
      occurredAt: Date.now(),
      source: 'protocol',
      payload: { stderr: d.toString('utf8') }
    })
  })

  child.on('exit', (code) => opts.onExit(code))

  return child
}

function normalize(value: unknown, fallbackAt: number): AgentEvent {
  const o = (value ?? {}) as Record<string, unknown>
  return {
    kind: (o['kind'] as AgentEventKind) ?? 'warning',
    occurredAt: (o['occurredAt'] as number) ?? fallbackAt,
    source: (o['source'] as AgentEvent['source']) ?? 'protocol',
    payload: o['payload'] ?? {}
  }
}
