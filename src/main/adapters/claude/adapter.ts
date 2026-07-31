import type { AgentAdapter } from '../contract'
import { mapClaudeEvent } from './decode'
import { discoverExecutable } from '../shared/discover'

// Model-1 (one-shot + resume). --bare skips hooks/LSP/plugins so stdout isn't flooded with
// config-inheritance noise (see PROBE.md). --verbose is required for stream-json in print mode.
const EXECUTABLE = discoverExecutable('claude')
const AUTO_APPROVE = ['--dangerously-skip-permissions'] as const

function baseArgv(text: string): readonly string[] {
  return ['-p', text, '--output-format', 'stream-json', '--verbose', '--bare', ...AUTO_APPROVE]
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  executable: EXECUTABLE,
  autoApproveFlags: AUTO_APPROVE,

  buildStartArgv: ({ text }) => baseArgv(text),

  buildResumeArgv: ({ text, nativeSessionId }) =>
    ['-p', text, '--output-format', 'stream-json', '--verbose', '--bare', ...AUTO_APPROVE, '--resume', nativeSessionId],

  mapRaw: (raw) => mapClaudeEvent(raw),

  extractSessionId: (events) => {
    for (const e of events) {
      if (e.kind === 'session-identified') {
        const sid = (e.payload as { sessionId?: unknown }).sessionId
        if (typeof sid === 'string') return sid
      }
    }
    return null
  }
}
