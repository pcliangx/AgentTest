import { validateAgentName } from './agent-name'
import type { ConfigurationOwner, WorkbenchViewModel } from './contract'

/**
 * Configuration field catalogue and validation (#13).
 *
 * This module is the SINGLE source of the field catalogue: the adapter
 * validates against it and the Settings editor renders from it. The
 * renderer never invents fields, options or effect timing — it only
 * resolves dynamic option sources (ready providers, connections) from the
 * live snapshot.
 */

export type ConfigurationSectionKey =
  | 'general'
  | 'defaults'
  | 'instances'
  | 'integrations'
  | 'permissions'

export type ConfigurationFieldTiming = 'immediate' | 'next-run' | 'new-agent'

export interface ConfigurationFieldDescriptor {
  fieldPath: string
  ownerKind: 'project' | 'agent'
  section: ConfigurationSectionKey
  label: string
  kind: 'text' | 'number' | 'select'
  /** When the applied value takes effect (US-71/US-91). */
  timing: ConfigurationFieldTiming
  /** Static options for select fields. */
  options?: ReadonlyArray<{ value: string; label: string }>
  /** Options resolved from the live snapshot instead of a static list. */
  dynamicOptions?: 'ready-providers' | 'connections'
}

export const CONFIGURATION_FIELDS: readonly ConfigurationFieldDescriptor[] = [
  {
    fieldPath: 'general.name',
    ownerKind: 'project',
    section: 'general',
    label: '项目名称',
    kind: 'text',
    timing: 'immediate'
  },
  {
    fieldPath: 'general.landingSurface',
    ownerKind: 'project',
    section: 'general',
    label: '默认落点工作面',
    kind: 'select',
    timing: 'immediate',
    options: [
      { value: 'overview', label: '概览' },
      { value: 'agents', label: 'Agent' }
    ]
  },
  {
    fieldPath: 'defaults.providerId',
    ownerKind: 'project',
    section: 'defaults',
    label: '默认 Provider',
    kind: 'select',
    timing: 'new-agent',
    dynamicOptions: 'ready-providers'
  },
  {
    fieldPath: 'defaults.model',
    ownerKind: 'project',
    section: 'defaults',
    label: '默认模型',
    kind: 'text',
    timing: 'new-agent'
  },
  {
    fieldPath: 'defaults.openMode',
    ownerKind: 'project',
    section: 'defaults',
    label: '新建 Agent 打开方式',
    kind: 'select',
    timing: 'new-agent',
    options: [
      { value: 'current-panel', label: '当前 Panel' },
      { value: 'new-panel', label: '新 Panel' },
      { value: 'background', label: '后台打开' }
    ]
  },
  {
    fieldPath: 'defaults.worktreeMode',
    ownerKind: 'project',
    section: 'defaults',
    label: 'worktree 模式',
    kind: 'select',
    timing: 'new-agent',
    options: [
      { value: 'isolated', label: '独立 worktree' },
      { value: 'read-only-shared', label: '共享只读' }
    ]
  },
  {
    fieldPath: 'integrations.primaryConnectionId',
    ownerKind: 'project',
    section: 'integrations',
    label: '主连接',
    kind: 'select',
    timing: 'immediate',
    dynamicOptions: 'connections'
  },
  {
    fieldPath: 'integrations.resourceScope',
    ownerKind: 'project',
    section: 'integrations',
    label: '资源范围',
    kind: 'text',
    timing: 'next-run'
  },
  {
    fieldPath: 'permissions.defaultPolicy',
    ownerKind: 'project',
    section: 'permissions',
    label: '默认权限策略',
    kind: 'select',
    timing: 'next-run',
    options: [
      { value: 'ask-each-time', label: '每次询问' },
      { value: 'deny-by-default', label: '默认拒绝' }
    ]
  },
  {
    fieldPath: 'identity.name',
    ownerKind: 'agent',
    section: 'instances',
    label: 'Agent 名称',
    kind: 'text',
    timing: 'immediate'
  },
  {
    fieldPath: 'model.id',
    ownerKind: 'agent',
    section: 'instances',
    label: '模型',
    kind: 'text',
    timing: 'next-run'
  },
  {
    fieldPath: 'proxy.http',
    ownerKind: 'agent',
    section: 'instances',
    label: 'HTTP 代理',
    kind: 'text',
    timing: 'next-run'
  },
  {
    fieldPath: 'env.custom',
    ownerKind: 'agent',
    section: 'instances',
    label: '自定义环境变量',
    kind: 'text',
    timing: 'next-run'
  },
  {
    fieldPath: 'concurrency.priority',
    ownerKind: 'agent',
    section: 'instances',
    label: '优先级',
    kind: 'select',
    timing: 'next-run',
    options: [
      { value: 'low', label: '低' },
      { value: 'normal', label: '普通' },
      { value: 'high', label: '高' }
    ]
  },
  {
    fieldPath: 'budget.maxTokens',
    ownerKind: 'agent',
    section: 'instances',
    label: 'Token 预算上限',
    kind: 'number',
    timing: 'next-run'
  }
]

const FIELDS_BY_PATH = new Map(
  CONFIGURATION_FIELDS.map((f) => [f.fieldPath, f])
)

export function fieldDescriptor(
  fieldPath: string
): ConfigurationFieldDescriptor | undefined {
  return FIELDS_BY_PATH.get(fieldPath)
}

export const PROJECT_FIELD_PATHS: readonly string[] = CONFIGURATION_FIELDS.filter(
  (f) => f.ownerKind === 'project'
).map((f) => f.fieldPath)

export const AGENT_FIELD_PATHS: readonly string[] = CONFIGURATION_FIELDS.filter(
  (f) => f.ownerKind === 'agent'
).map((f) => f.fieldPath)

export function fieldPathsFor(owner: ConfigurationOwner): readonly string[] {
  return owner.kind === 'project' ? PROJECT_FIELD_PATHS : AGENT_FIELD_PATHS
}

/** Stable string key for owner comparisons (never a visible name). */
export function ownerKey(owner: ConfigurationOwner): string {
  return owner.kind === 'project'
    ? `project:${owner.projectId}`
    : `agent:${owner.agentInstanceId}`
}

export function sameOwner(
  a: ConfigurationOwner,
  b: ConfigurationOwner
): boolean {
  return ownerKey(a) === ownerKey(b)
}

/**
 * Validates a staged value for an owner's field. Returns an error message
 * or null when the value is acceptable.
 */
export function validateConfigurationValue(
  owner: ConfigurationOwner,
  fieldPath: string,
  value: unknown,
  snapshot: WorkbenchViewModel
): string | null {
  // Enum options come from the single catalogue descriptor.
  const descriptor = FIELDS_BY_PATH.get(fieldPath)
  if (descriptor?.options) {
    if (!descriptor.options.some((o) => o.value === value)) {
      return `取值必须是：${descriptor.options.map((o) => o.value).join(' / ')}`
    }
    return null
  }
  switch (fieldPath) {
    case 'general.name':
      return typeof value === 'string' && value.trim().length > 0
        ? null
        : '项目名称不能为空'
    case 'identity.name': {
      if (owner.kind !== 'agent') return '字段不属于该 owner'
      const check = validateAgentName(String(value ?? ''))
      if (!check.ok) return check.reason ?? '名称无效'
      const agent = snapshot.agents.find(
        (a) => a.agentInstanceId === owner.agentInstanceId
      )
      if (!agent) return 'Agent 不存在'
      const name = String(value).trim()
      // Rename keeps the instance's own identity — exclude itself from the
      // project-wide, case-insensitive uniqueness check.
      const taken = snapshot.agents.some(
        (a) =>
          a.projectId === agent.projectId &&
          a.agentInstanceId !== owner.agentInstanceId &&
          a.name.toLowerCase() === name.toLowerCase()
      )
      return taken ? `Agent 名称 "${name}" 已存在` : null
    }
    case 'integrations.primaryConnectionId':
      // 0..1: null clears the binding; otherwise the connection must exist.
      if (value === null) return null
      return snapshot.global.connections.some(
        (c) => c.connectionId === value
      )
        ? null
        : '连接不存在'
    case 'defaults.providerId':
      return snapshot.global.providers.some(
        (p) => p.providerId === value && p.status === 'ready'
      )
        ? null
        : 'Provider 不可用'
    case 'budget.maxTokens':
      return Number.isInteger(value) && (value as number) > 0
        ? null
        : 'Token 预算必须是正整数'
    case 'defaults.model':
    case 'model.id':
      return typeof value === 'string' && value.trim().length > 0
        ? null
        : '模型不能为空'
    case 'proxy.http':
    case 'env.custom':
    case 'integrations.resourceScope':
      return typeof value === 'string' ? null : '取值必须是文本'
    default:
      return '字段不存在'
  }
}

/**
 * Normalises a value before it becomes applied truth. Identity names are
 * stored trimmed so the applied value and the visible name never drift.
 */
export function normalizeAppliedValue(fieldPath: string, value: unknown): unknown {
  if (
    (fieldPath === 'identity.name' || fieldPath === 'general.name') &&
    typeof value === 'string'
  ) {
    return value.trim()
  }
  return value
}
