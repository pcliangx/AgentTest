import type { WorkbenchViewModel } from './workbench/contract'

/** Connection health states as owned by the adapter (#6). */
export type ConnectionStatus =
  WorkbenchViewModel['global']['connections'][number]['status']

/**
 * Chinese labels for connection health — shared by the Connections surface
 * and the Settings integrations badge (#68). The renderer always restates
 * the adapter-owned `status`; a configured binding alone never implies
 * 已连接.
 */
export const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: '已连接',
  disconnected: '未连接',
  offline: '离线',
  error: '错误'
}
