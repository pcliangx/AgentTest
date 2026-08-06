import type { ActivityKind } from './workbench/contract'
import type { StatusChipTone } from './status-chip'

export const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  'run-started': '运行开始',
  'run-completed': '运行完成',
  'run-failed': '运行失败',
  'run-interrupted': '运行已中断',
  'run-cancelled': '运行已取消',
  'configuration-applied': '配置已应用',
  'permission-decided': '权限已决定',
  'attention-resolved': '关注已处理',
  'instruction-sent': '指令已发送',
  'dispatch-created': '派发已创建',
  'execution-result-reviewed': '结果已评审',
  'external-task-write': '外部任务已写入',
  'external-task-write-failed': '外部任务写入失败',
  'external-task-conflict-resolved': '拟议修改已放弃',
  'queue-cancelled': '排队已取消',
  'dangerous-action-confirmed': '高风险操作已确认',
  'provider-rescanned': 'CLI 已扫描',
  'provider-tested': 'Provider 已测试',
  'provider-enabled': 'Provider 已接入'
}

export function activityKindLabel(kind: ActivityKind): string {
  return ACTIVITY_KIND_LABEL[kind]
}

/**
 * #69 triple-encoding for activity rows: outcome families get teal/amber/
 * red, in-flight and informational entries stay brand/neutral. The icon is
 * decorative; the label always names the kind.
 */
export const ACTIVITY_KIND_CHIP: Record<
  ActivityKind,
  { tone: StatusChipTone; icon: string }
> = {
  'run-started': { tone: 'brand', icon: '●' },
  'run-completed': { tone: 'good', icon: '✓' },
  'run-failed': { tone: 'danger', icon: '✕' },
  'run-interrupted': { tone: 'warn', icon: '⚠' },
  'run-cancelled': { tone: 'warn', icon: '⚠' },
  'configuration-applied': { tone: 'good', icon: '✓' },
  'permission-decided': { tone: 'neutral', icon: '●' },
  'attention-resolved': { tone: 'good', icon: '✓' },
  'instruction-sent': { tone: 'brand', icon: '●' },
  'dispatch-created': { tone: 'brand', icon: '●' },
  'execution-result-reviewed': { tone: 'good', icon: '✓' },
  'external-task-write': { tone: 'neutral', icon: '●' },
  'external-task-write-failed': { tone: 'danger', icon: '✕' },
  'external-task-conflict-resolved': { tone: 'good', icon: '✓' },
  'queue-cancelled': { tone: 'warn', icon: '⚠' },
  'dangerous-action-confirmed': { tone: 'neutral', icon: '●' },
  'provider-rescanned': { tone: 'brand', icon: '⟳' },
  'provider-tested': { tone: 'good', icon: '✓' },
  'provider-enabled': { tone: 'good', icon: '⚡' }
}
