import type { AgentProviderId, AgentRuntimeState } from './workbench/contract'

/**
 * Shared display metadata — labels only, never business branching.
 * Used by both the Agents surface (directory, dialogs) and the workspace
 * layout (tabs, agent view) so the two never drift apart.
 */

export const PROVIDER_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'kimi-code': 'Kimi Code',
  'gemini-cli': 'Gemini CLI'
}

export function providerLabel(providerId: AgentProviderId): string {
  return PROVIDER_LABEL[providerId] ?? providerId
}

/**
 * Two-letter Provider abbreviations for the context-pane avatar (#66),
 * mirroring the frozen prototype's `providerCode` (CC / CX / KM). Unknown
 * providers fall back to their first two letters, uppercased.
 */
export const PROVIDER_CODE: Record<string, string> = {
  'claude-code': 'CC',
  codex: 'CX',
  'kimi-code': 'KM',
  'gemini-cli': 'GM'
}

export function providerCode(providerId: AgentProviderId): string {
  return PROVIDER_CODE[providerId] ?? providerId.slice(0, 2).toUpperCase()
}

export const RUNTIME_STATE_LABEL: Record<AgentRuntimeState, string> = {
  ready: '就绪',
  queued: '排队中',
  starting: '启动中',
  running: '运行中',
  finishing: '收尾中',
  'needs-input': '需要输入',
  'permission-requested': '等待权限',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  unavailable: '不可用',
  archived: '已归档'
}

export const TERMINAL_STATE_LABEL: Record<
  'closed' | 'opening' | 'active' | 'failed',
  string
> = {
  closed: 'Terminal 未接管',
  opening: 'Terminal 正在打开',
  active: 'Terminal 接管中',
  failed: 'Terminal 打开失败'
}
