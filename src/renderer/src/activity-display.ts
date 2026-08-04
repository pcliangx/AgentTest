import type { ActivityKind } from './workbench/contract'

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
  'queue-cancelled': '排队已取消',
  'dangerous-action-confirmed': '高风险操作已确认'
}

export function activityKindLabel(kind: ActivityKind): string {
  return ACTIVITY_KIND_LABEL[kind]
}
