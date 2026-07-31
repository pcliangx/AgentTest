import type { AgentAdapter } from '../contract'
import { discoverExecutable } from '../shared/discover'
import { createCodexEventDecoder } from './decode'

const EXECUTABLE = discoverExecutable('codex')

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  executable: EXECUTABLE,
  terminalArgv: [],
  conversationMode: 'native-resume',
  protocol: {
    kind: 'jsonl',
    promptInput: 'text',
    createDecoder: createCodexEventDecoder
  },

  buildArgv: ({ cwd, nativeSessionId }) => {
    if (nativeSessionId) {
      return [
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        '-c',
        'sandbox_mode="workspace-write"',
        '-c',
        'sandbox_workspace_write.network_access=true',
        nativeSessionId
      ]
    }
    return [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '-C',
      cwd
    ]
  }
}
