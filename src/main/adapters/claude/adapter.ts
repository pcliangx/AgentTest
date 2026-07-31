import type { AgentAdapter } from '../contract'
import { createClaudeEventDecoder } from './decode'
import { discoverExecutable, executableHelpIncludes } from '../shared/discover'

const TERMINAL_ARGV = ['--dangerously-skip-permissions'] as const
const STRUCTURED_PERMISSION_ARGV = ['--permission-mode', 'bypassPermissions'] as const

export interface ClaudeAdapterOptions {
  readonly executable?: string
  readonly partialMessages?: boolean
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): AgentAdapter {
  const executable = options.executable ?? discoverExecutable('claude')
  const partialMessages =
    options.partialMessages ??
    executableHelpIncludes(executable, ['-p', '--help'], '--include-partial-messages')

  return {
    id: 'claude',
    displayName: 'Claude Code',
    executable,
    terminalArgv: TERMINAL_ARGV,
    conversationMode: 'native-resume',
    protocol: {
      kind: 'jsonl',
      promptInput: 'claude-stream-json',
      createDecoder: createClaudeEventDecoder
    },

    buildArgv: ({ nativeSessionId }) => {
      const argv = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        ...STRUCTURED_PERMISSION_ARGV
      ]
      if (partialMessages) argv.push('--include-partial-messages')
      if (nativeSessionId) argv.push('--resume', nativeSessionId)
      return argv
    }
  }
}

export const claudeAdapter = createClaudeAdapter()
