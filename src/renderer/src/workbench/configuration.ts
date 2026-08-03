import { validateAgentName } from './agent-name'
import type { ConfigurationOwner, WorkbenchViewModel } from './contract'

/**
 * Configuration field catalogue and validation (#13).
 *
 * The adapter owns this catalogue — the renderer never invents fields and
 * only stages paths listed here. Identity and references (names, primary
 * connection, default provider) are validated against the live snapshot;
 * run-configuration fields only check shape, because they take effect on
 * the next Run and never rewrite an active Run's snapshot.
 */

export const PROJECT_FIELD_PATHS: readonly string[] = [
  'general.name',
  'general.landingSurface',
  'defaults.providerId',
  'defaults.model',
  'defaults.openMode',
  'defaults.worktreeMode',
  'integrations.primaryConnectionId',
  'integrations.resourceScope',
  'permissions.defaultPolicy'
]

export const AGENT_FIELD_PATHS: readonly string[] = [
  'identity.name',
  'model.id',
  'proxy.http',
  'env.custom',
  'concurrency.priority',
  'budget.maxTokens'
]

export function fieldPathsFor(owner: ConfigurationOwner): readonly string[] {
  return owner.kind === 'project' ? PROJECT_FIELD_PATHS : AGENT_FIELD_PATHS
}

const ENUM_VALUES: Record<string, readonly string[]> = {
  'general.landingSurface': ['overview', 'agents'],
  'defaults.openMode': ['current-panel', 'new-panel', 'background'],
  'defaults.worktreeMode': ['isolated', 'read-only-shared'],
  'permissions.defaultPolicy': ['ask-each-time', 'deny-by-default'],
  'concurrency.priority': ['low', 'normal', 'high']
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
  const enumValues = ENUM_VALUES[fieldPath]
  if (enumValues && !enumValues.includes(value as string)) {
    return `取值必须是：${enumValues.join(' / ')}`
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
