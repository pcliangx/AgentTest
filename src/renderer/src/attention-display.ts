import type { AttentionItemKind, AttentionTarget } from './workbench/contract'

/** Chinese labels for the Global Attention Center aggregation kinds (#9). */
export const ATTENTION_KIND_LABEL: Record<AttentionItemKind, string> = {
  'permission-requested': '权限请求',
  'needs-input': '待输入',
  failed: '失败',
  interrupted: '中断',
  completed: '完成',
  'connection-conflict': '连接冲突',
  'provider-unavailable': 'Provider 不可用'
}

/** Human-readable retained-target label for undelivered detail views. */
export function describeAttentionTarget(target: AttentionTarget): string {
  switch (target.kind) {
    case 'project':
      return `Project ${target.projectId}`
    case 'agent':
      return `Agent ${target.agentInstanceId}`
    case 'run':
      return `Run ${target.runId}`
    case 'project-task':
      return `Project Task ${target.projectTaskId}`
    case 'external-task':
      return `External Task ${target.externalTaskId}`
    case 'knowledge':
      return `Knowledge ${target.knowledgeResourceId}`
    case 'handoff':
      return `Handoff ${target.handoffId}`
  }
}
