import type { AgentAdapter } from '../contract'
import { discoverExecutable } from '../shared/discover'

const EXECUTABLE = discoverExecutable('kimi')

export const kimiAdapter: AgentAdapter = {
  id: 'kimi',
  displayName: 'Kimi Code',
  executable: EXECUTABLE,
  terminalArgv: ['--yolo'],
  conversationMode: 'transcript',
  protocol: { kind: 'acp-json-rpc', stageTimeoutMs: 30_000 },
  buildArgv: () => ['acp']
}
