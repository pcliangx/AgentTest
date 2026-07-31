// Phase 0 dummy agent emitter. Emits fake AgentEvent-shaped JSONL on stdout so the
// spawn → decode → IPC → pane pipeline can be validated before any real adapter exists.
// Replaced by real CLIs in Phase 1. Usage: node dummy-agent.mjs <target>

import { setTimeout as sleep } from 'node:timers/promises'

const target = process.argv[2] ?? 'unknown'

const events = [
  { kind: 'assistant-text', payload: { text: `(dummy) hello from ${target}` } },
  { kind: 'tool-start', payload: { tool: 'read_file', arg: 'README.md' } },
  { kind: 'tool-end', payload: { tool: 'read_file', status: 'ok' } },
  { kind: 'usage', payload: { tokens: 42 } },
  { kind: 'turn-complete', payload: {} }
]

for (const event of events) {
  process.stdout.write(JSON.stringify(event) + '\n')
  await sleep(250)
}
