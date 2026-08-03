import { useEffect, useState } from 'react'
import type {
  AgentInstanceViewModel,
  ConfigurationOwner,
  ProjectViewModel,
  WorkbenchViewModel
} from './workbench/contract'
import { ownerKey } from './workbench/configuration'
import type { SendCommand } from './agents-surface'

/**
 * Settings A — the single full configuration editor (#13).
 *
 * Six stable sections plus the pending-changes summary. Editing only ever
 * stages drafts through the port; applied truth, active Runs and identity
 * change solely via an explicit atomic apply. The renderer owns no
 * configuration rules: field values, versions, drafts and validation
 * errors all come from the WorkbenchViewModel.
 */

type FieldTiming = 'immediate' | 'next-run' | 'new-agent'

interface FieldMeta {
  label: string
  kind: 'text' | 'number' | 'select'
  timing: FieldTiming
  options?: Array<{ value: string; label: string }>
}

const TIMING_LABEL: Record<FieldTiming, string> = {
  immediate: '立即生效',
  'next-run': '下一 Run 生效',
  'new-agent': '新建 Agent 生效'
}

const PROJECT_FIELD_META: Record<string, FieldMeta> = {
  'general.name': { label: '项目名称', kind: 'text', timing: 'immediate' },
  'general.landingSurface': {
    label: '默认落点工作面',
    kind: 'select',
    timing: 'immediate',
    options: [
      { value: 'overview', label: '概览' },
      { value: 'agents', label: 'Agent' }
    ]
  },
  'defaults.providerId': {
    label: '默认 Provider',
    kind: 'select',
    timing: 'new-agent'
  },
  'defaults.model': { label: '默认模型', kind: 'text', timing: 'new-agent' },
  'defaults.openMode': {
    label: '新建 Agent 打开方式',
    kind: 'select',
    timing: 'new-agent',
    options: [
      { value: 'current-panel', label: '当前 Panel' },
      { value: 'new-panel', label: '新 Panel' },
      { value: 'background', label: '后台打开' }
    ]
  },
  'defaults.worktreeMode': {
    label: 'worktree 模式',
    kind: 'select',
    timing: 'new-agent',
    options: [
      { value: 'isolated', label: '独立 worktree' },
      { value: 'read-only-shared', label: '共享只读' }
    ]
  },
  'integrations.primaryConnectionId': {
    label: '主连接',
    kind: 'select',
    timing: 'immediate'
  },
  'integrations.resourceScope': {
    label: '资源范围',
    kind: 'text',
    timing: 'next-run'
  },
  'permissions.defaultPolicy': {
    label: '默认权限策略',
    kind: 'select',
    timing: 'next-run',
    options: [
      { value: 'ask-each-time', label: '每次询问' },
      { value: 'deny-by-default', label: '默认拒绝' }
    ]
  }
}

const AGENT_FIELD_META: Record<string, FieldMeta> = {
  'identity.name': { label: 'Agent 名称', kind: 'text', timing: 'immediate' },
  'model.id': { label: '模型', kind: 'text', timing: 'next-run' },
  'proxy.http': { label: 'HTTP 代理', kind: 'text', timing: 'next-run' },
  'env.custom': {
    label: '自定义环境变量',
    kind: 'text',
    timing: 'next-run'
  },
  'concurrency.priority': {
    label: '优先级',
    kind: 'select',
    timing: 'next-run',
    options: [
      { value: 'low', label: '低' },
      { value: 'normal', label: '普通' },
      { value: 'high', label: '高' }
    ]
  },
  'budget.maxTokens': {
    label: 'Token 预算上限',
    kind: 'number',
    timing: 'next-run'
  }
}

const FIELD_META: Record<string, FieldMeta> = {
  ...PROJECT_FIELD_META,
  ...AGENT_FIELD_META
}

const SECTIONS = [
  { key: 'general', label: '常规' },
  { key: 'defaults', label: 'Agent 默认配置' },
  { key: 'instances', label: 'Agent 实例' },
  { key: 'integrations', label: '集成' },
  { key: 'permissions', label: '权限' },
  { key: 'storage', label: '存储' }
] as const

type SectionKey = (typeof SECTIONS)[number]['key']

const PROJECT_SECTION_FIELDS: Record<SectionKey, string[]> = {
  general: ['general.name', 'general.landingSurface'],
  defaults: [
    'defaults.providerId',
    'defaults.model',
    'defaults.openMode',
    'defaults.worktreeMode'
  ],
  instances: [],
  integrations: ['integrations.primaryConnectionId', 'integrations.resourceScope'],
  permissions: ['permissions.defaultPolicy'],
  storage: []
}

const AGENT_SECTION_FIELDS = [
  'identity.name',
  'model.id',
  'proxy.http',
  'env.custom',
  'concurrency.priority',
  'budget.maxTokens'
]

const ROOT_LABEL: Record<string, string> = {
  available: '可用',
  unavailable: '不可用'
}

const GIT_LABEL: Record<string, string> = {
  ready: '已就绪',
  'not-ready': '未就绪'
}

// ---------------------------------------------------------------------------
// Settings surface
// ---------------------------------------------------------------------------

export function SettingsSurface({
  project,
  snapshot,
  sendCommand
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  sendCommand: SendCommand
}) {
  const [section, setSection] = useState<SectionKey>('general')
  const projectAgents = snapshot.agents.filter(
    (a) => a.projectId === project.projectId
  )
  const [selectedAgentId, setSelectedAgentId] = useState(
    projectAgents[0]?.agentInstanceId ?? ''
  )
  const [showApplyDialog, setShowApplyDialog] = useState(false)
  const [feedback, setFeedback] = useState<
    { kind: 'status' | 'alert'; message: string } | null
  >(null)

  const projectOwner: ConfigurationOwner = {
    kind: 'project',
    projectId: project.projectId
  }
  const selectedAgent = projectAgents.find(
    (a) => a.agentInstanceId === selectedAgentId
  )
  const selectedOwner: ConfigurationOwner | null = selectedAgent
    ? { kind: 'agent', agentInstanceId: selectedAgent.agentInstanceId }
    : null

  const appliedFor = (owner: ConfigurationOwner) =>
    snapshot.appliedConfigurations.find(
      (c) => ownerKey(c.owner) === ownerKey(owner)
    )
  const draftFor = (owner: ConfigurationOwner) =>
    snapshot.configurationDrafts.find(
      (d) => ownerKey(d.owner) === ownerKey(owner)
    )
  const ownerLabel = (owner: ConfigurationOwner): string =>
    owner.kind === 'project'
      ? (snapshot.projects.find((p) => p.projectId === owner.projectId)?.name ??
        owner.projectId)
      : (snapshot.agents.find(
          (a) => a.agentInstanceId === owner.agentInstanceId
        )?.name ?? owner.agentInstanceId)

  const optionsFor = (fieldPath: string) => {
    if (fieldPath === 'defaults.providerId') {
      return snapshot.global.providers
        .filter((p) => p.status === 'ready')
        .map((p) => ({ value: p.providerId as string, label: p.displayName }))
    }
    if (fieldPath === 'integrations.primaryConnectionId') {
      return [
        { value: '', label: '无连接' },
        ...snapshot.global.connections.map((c) => ({
          value: c.connectionId as string,
          label: c.label
        }))
      ]
    }
    return FIELD_META[fieldPath]?.options ?? []
  }

  const formatValue = (fieldPath: string, value: unknown): string => {
    if (fieldPath === 'integrations.primaryConnectionId') {
      if (value === null || value === '') return '无连接'
      return (
        snapshot.global.connections.find((c) => c.connectionId === value)
          ?.label ?? String(value)
      )
    }
    const option = optionsFor(fieldPath).find((o) => o.value === value)
    return option?.label ?? String(value)
  }

  const stage = (
    owner: ConfigurationOwner,
    fieldPath: string,
    value: unknown
  ) => {
    setFeedback(null)
    void sendCommand({ kind: 'stage-configuration', owner, fieldPath, value })
  }

  const draftsWithChanges = snapshot.configurationDrafts.filter(
    (d) => d.changes.length > 0
  )

  const confirmApply = async () => {
    const owners = draftsWithChanges.map((d) => ({
      owner: d.owner,
      expectedAppliedVersion: appliedFor(d.owner)?.appliedVersion ?? 0
    }))
    const result = await sendCommand({ kind: 'apply-configuration', owners })
    // Close after every decision: a rejection refreshes the drafts with
    // validation errors, and re-opening rebuilds the summary from the
    // latest rendered snapshot.
    setShowApplyDialog(false)
    if (result.ok) {
      setFeedback({
        kind: 'status',
        message: `已应用 ${owners.length} 个 owner 的配置变更`
      })
    } else {
      setFeedback({ kind: 'alert', message: result.message })
    }
  }

  const renderFieldRows = (owner: ConfigurationOwner, fieldPaths: string[]) => {
    const applied = appliedFor(owner)
    const draft = draftFor(owner)
    if (!applied) return null
    return (
      <ul className="space-y-3">
        {fieldPaths.map((fieldPath) => (
          <ConfigFieldRow
            key={fieldPath}
            fieldPath={fieldPath}
            meta={FIELD_META[fieldPath]}
            appliedValue={applied.values[fieldPath]}
            appliedVersion={applied.appliedVersion}
            draftChange={draft?.changes.find((c) => c.fieldPath === fieldPath)}
            error={
              draft?.validationErrors.find((e) => e.fieldPath === fieldPath)
                ?.message
            }
            options={optionsFor(fieldPath)}
            formatValue={(v) => formatValue(fieldPath, v)}
            onStage={(value) => stage(owner, fieldPath, value)}
          />
        ))}
      </ul>
    )
  }

  return (
    <section
      role="region"
      aria-label="项目设置"
      className="flex h-full min-h-0 gap-4"
    >
      <nav
        aria-label="设置目录"
        className="w-40 shrink-0 space-y-0.5 border-r border-neutral-800 pr-3"
      >
        {SECTIONS.map(({ key, label }) => (
          <button
            key={key}
            aria-current={section === key ? 'page' : undefined}
            className={`block w-full rounded px-2 py-1 text-left text-sm ${
              section === key
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
            }`}
            onClick={() => setSection(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-auto pr-2">
        <p className="mb-4 text-xs text-neutral-500">
          布局、当前工作面与过滤器会自动保存；以下配置需点击应用后生效。
        </p>

        {section === 'general' && (
          <div>
            <p className="mb-3 text-xs text-neutral-500">
              根目录：{ROOT_LABEL[project.rootAvailability]} · Git：
              {GIT_LABEL[project.repositoryReadiness]}
            </p>
            {renderFieldRows(projectOwner, PROJECT_SECTION_FIELDS.general)}
          </div>
        )}

        {section === 'defaults' && (
          <div>
            <p className="mb-3 text-xs text-neutral-500">
              默认配置只影响之后创建的实例，不追溯修改现有实例。
            </p>
            {renderFieldRows(projectOwner, PROJECT_SECTION_FIELDS.defaults)}
          </div>
        )}

        {section === 'instances' && (
          <div>
            <label className="mb-3 block text-xs text-neutral-400">
              选择实例
              <select
                aria-label="选择实例"
                className="mt-1 block w-64 rounded bg-neutral-900 px-2 py-1 text-sm text-neutral-200 outline-none"
                value={selectedAgentId}
                onChange={(e) =>
                  setSelectedAgentId(
                    e.target.value as AgentInstanceViewModel['agentInstanceId']
                  )
                }
              >
                {projectAgents.map((a) => (
                  <option key={a.agentInstanceId} value={a.agentInstanceId}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            {selectedAgent?.activeRunConfigVersion !== undefined && (
              <p className="mb-3 text-xs text-amber-300">
                当前 Run 配置快照：v{selectedAgent.activeRunConfigVersion}
                （应用不影响进行中的 Run）
              </p>
            )}
            {selectedOwner &&
              renderFieldRows(selectedOwner, AGENT_SECTION_FIELDS)}
          </div>
        )}

        {section === 'integrations' && (
          <div>
            {renderFieldRows(
              projectOwner,
              PROJECT_SECTION_FIELDS.integrations
            )}
            <p className="mt-4 text-xs text-neutral-500">
              人工浏览器身份与 Connector 执行身份相互隔离；连接凭据不会进入
              Project 配置或导出内容。
            </p>
          </div>
        )}

        {section === 'permissions' && (
          <div>
            {renderFieldRows(
              projectOwner,
              PROJECT_SECTION_FIELDS.permissions
            )}
            <p className="mt-4 text-xs text-neutral-500">
              仅展示可真正强制的策略；有效策略矩阵与下一次 Run 的 readiness
              摘要将由后续工作面提供。
            </p>
          </div>
        )}

        {section === 'storage' && (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-neutral-500">
              本地数据仅保存在本机，滚动快照随 schema 版本保留；凭据、Token
              与 Cookie 不进入 Project 数据。
            </p>
            <div className="flex gap-2">
              <button
                className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
                disabled
                title="导出将在后续版本提供"
              >
                导出
              </button>
              <button
                className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
                disabled
                title="导入将在后续版本提供"
              >
                导入
              </button>
            </div>
          </div>
        )}
      </div>

      <aside
        aria-label="待应用摘要"
        className="flex w-72 shrink-0 flex-col rounded border border-neutral-800 p-3"
      >
        <h3 className="mb-2 text-sm font-medium text-neutral-200">待应用摘要</h3>
        {draftsWithChanges.length === 0 ? (
          <p className="text-xs text-neutral-500">暂无待应用变更</p>
        ) : (
          <ul className="min-h-0 flex-1 space-y-2 overflow-auto">
            {draftsWithChanges.map((draft) => {
              const label = ownerLabel(draft.owner)
              return (
                <li
                  key={ownerKey(draft.owner)}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="text-neutral-300">
                    {label}：{draft.changes.length} 项变更
                  </span>
                  <button
                    aria-label={`丢弃「${label}」的草稿`}
                    className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                    onClick={() => {
                      setFeedback(null)
                      void sendCommand({
                        kind: 'discard-configuration',
                        owners: [draft.owner]
                      })
                    }}
                  >
                    丢弃
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <button
          className="mt-3 rounded bg-neutral-700 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-600 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={draftsWithChanges.length === 0}
          onClick={() => {
            setFeedback(null)
            setShowApplyDialog(true)
          }}
        >
          应用全部变更
        </button>
        {feedback && (
          <p
            role={feedback.kind === 'alert' ? 'alert' : 'status'}
            className={`mt-2 text-xs ${
              feedback.kind === 'alert' ? 'text-red-400' : 'text-emerald-400'
            }`}
          >
            {feedback.message}
          </p>
        )}
      </aside>

      {showApplyDialog && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
          <div
            role="dialog"
            aria-label="应用配置变更"
            className="w-full max-w-lg space-y-3 rounded-lg border border-neutral-700 bg-neutral-900 p-4"
          >
            <h3 className="text-sm font-medium text-neutral-100">
              应用配置变更
            </h3>
            <p className="text-xs text-neutral-500">
              以下变更将原子提交：任一验证失败都不会修改任何 applied 配置。
            </p>
            <ul className="max-h-64 space-y-1.5 overflow-auto text-xs">
              {draftsWithChanges.flatMap((draft) =>
                draft.changes.map((change) => (
                  <li
                    key={`${ownerKey(draft.owner)}:${change.fieldPath}`}
                    className="text-neutral-300"
                  >
                    {ownerLabel(draft.owner)} ·{' '}
                    {FIELD_META[change.fieldPath]?.label ?? change.fieldPath}：
                    {formatValue(change.fieldPath, change.applied)} →{' '}
                    {formatValue(change.fieldPath, change.draft)}
                  </li>
                ))
              )}
            </ul>
            <div className="flex justify-end gap-2">
              <button
                className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
                onClick={() => setShowApplyDialog(false)}
              >
                取消
              </button>
              <button
                className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-100 hover:bg-neutral-600"
                onClick={() => void confirmApply()}
              >
                确认应用
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Single configuration field row
// ---------------------------------------------------------------------------

function ConfigFieldRow({
  fieldPath,
  meta,
  appliedValue,
  appliedVersion,
  draftChange,
  error,
  options,
  formatValue,
  onStage
}: {
  fieldPath: string
  meta: FieldMeta
  appliedValue: unknown
  appliedVersion: number
  draftChange?: { fieldPath: string; applied: unknown; draft: unknown }
  error?: string
  options: Array<{ value: string; label: string }>
  formatValue: (value: unknown) => string
  onStage: (value: unknown) => void
}) {
  const shown =
    draftChange !== undefined ? String(draftChange.draft ?? '') : String(appliedValue ?? '')
  const [value, setValue] = useState(shown)
  // Re-sync only when the underlying truth (draft or applied) changes —
  // in-progress typing is local and survives unrelated re-renders.
  useEffect(() => setValue(shown), [shown])

  return (
    <li className="space-y-1">
      <div className="flex items-center gap-3">
        <span className="w-32 shrink-0 text-xs text-neutral-400">
          {meta.label}
        </span>
        {meta.kind === 'select' ? (
          <select
            aria-label={meta.label}
            className="w-64 rounded bg-neutral-900 px-2 py-1 text-sm text-neutral-200 outline-none"
            value={shown}
            onChange={(e) =>
              onStage(
                fieldPath === 'integrations.primaryConnectionId' &&
                  e.target.value === ''
                  ? null
                  : e.target.value
              )
            }
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={meta.label}
            className="w-64 rounded bg-neutral-900 px-2 py-1 text-sm text-neutral-200 outline-none"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => {
              if (value === shown) return
              onStage(meta.kind === 'number' ? Number(value) : value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        )}
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
          {TIMING_LABEL[meta.timing]}
        </span>
      </div>
      <div className="flex items-center gap-3 pl-[8.75rem] text-xs">
        <span className="text-neutral-500">
          当前：{formatValue(appliedValue)}（v{appliedVersion}）
        </span>
        {draftChange && (
          <span className="text-amber-300">
            待应用：{formatValue(draftChange.draft)}
          </span>
        )}
      </div>
      {error && <p className="pl-[8.75rem] text-xs text-red-400">{error}</p>}
    </li>
  )
}
