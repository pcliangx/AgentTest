import { useEffect, useRef, useState } from 'react'
import type {
  AgentInstanceViewModel,
  CommandResult,
  ConfigurationOwner,
  ProjectViewModel,
  RunReadinessBlockerTarget,
  WorkbenchViewModel
} from './workbench/contract'
import {
  AGENT_FIELD_PATHS,
  CONFIGURATION_FIELDS,
  fieldDescriptor,
  ownerKey,
  type ConfigurationFieldDescriptor,
  type ConfigurationFieldTiming
} from './workbench/configuration'
import { providerLabel } from './agent-display'
import type { SendCommand } from './agents-surface'

/**
 * Settings A — the single full configuration editor (#13), plus the two
 * read-only views (#14): the policy matrix (B) and the readiness summary (C).
 *
 * Six stable editing sections plus the pending-changes summary. Editing only
 * ever stages drafts through the port; applied truth, active Runs and
 * identity change solely via an explicit atomic apply. The renderer owns no
 * configuration rules: the field catalogue is shared with the adapter
 * (`CONFIGURATION_FIELDS`), and values, versions, drafts and validation
 * errors all come from the WorkbenchViewModel. The read-only views render
 * adapter-computed `effectiveConfigurations` / `runReadiness` and only ever
 * link back to the editing sections or the global Provider Health surface.
 */

const TIMING_LABEL: Record<ConfigurationFieldTiming, string> = {
  immediate: '立即生效',
  'next-run': '下一 Run 生效',
  'new-agent': '新建 Agent 生效'
}

const EDIT_SECTIONS = [
  { key: 'general', label: '常规' },
  { key: 'defaults', label: 'Agent 默认配置' },
  { key: 'instances', label: 'Agent 实例' },
  { key: 'integrations', label: '集成' },
  { key: 'permissions', label: '权限' },
  { key: 'storage', label: '存储' }
] as const

// Settings B/C (#14): read-only comparison and summary views. They own no
// editing or navigation logic — every edit path leads back to the sections
// above, which remain the single edit locations.
const READONLY_SECTIONS = [
  { key: 'matrix', label: '策略矩阵' },
  { key: 'readiness', label: 'Readiness 摘要' }
] as const

const SECTIONS = [...EDIT_SECTIONS, ...READONLY_SECTIONS]

type SectionKey = (typeof SECTIONS)[number]['key']

const PROJECT_SECTION_FIELDS: Record<SectionKey, string[]> = {
  general: fieldsOf('project', 'general'),
  defaults: fieldsOf('project', 'defaults'),
  instances: [],
  integrations: fieldsOf('project', 'integrations'),
  permissions: fieldsOf('project', 'permissions'),
  storage: [],
  matrix: [],
  readiness: []
}

const AGENT_SECTION_FIELDS = fieldsOf('agent', 'instances')

function fieldsOf(
  ownerKind: 'project' | 'agent',
  section: string
): string[] {
  return CONFIGURATION_FIELDS.filter(
    (f) => f.ownerKind === ownerKind && f.section === section
  ).map((f) => f.fieldPath)
}

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
  sendCommand,
  initialSection
}: {
  project: ProjectViewModel
  snapshot: WorkbenchViewModel
  sendCommand: SendCommand
  /** Optional deep-linked section (e.g. permissions from the Permission Center). */
  initialSection?: SectionKey
}) {
  const [section, setSection] = useState<SectionKey>(initialSection ?? 'general')
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
  const [applyAttempt, setApplyAttempt] = useState<{
    acceptedRevision: number
    owners: Array<{ ownerKey: string; targetAppliedVersion: number }>
    ownerCount: number
  } | null>(null)
  const [pendingStageCount, setPendingStageCount] = useState(0)
  // Revisions are global, so every stage shares one queue even when owners or
  // fields differ. Per-field queues could still dispatch the same revision.
  const stageTailRef = useRef<Promise<void>>(Promise.resolve())
  const activeRef = useRef(true)
  const snapshotRevisionRef = useRef(snapshot.revision)
  const revisionWaitersRef = useRef<
    Array<{ minimumRevision: number; resolve: () => void }>
  >([])
  snapshotRevisionRef.current = snapshot.revision

  // Command responses and view-model events may arrive in either order.
  // A stage remains pending until its accepted revision has actually rendered,
  // so Apply cannot build an owner list from an older snapshot.
  useEffect(() => {
    const ready: Array<() => void> = []
    const waiting: typeof revisionWaitersRef.current = []
    for (const waiter of revisionWaitersRef.current) {
      if (snapshot.revision >= waiter.minimumRevision) {
        ready.push(waiter.resolve)
      } else {
        waiting.push(waiter)
      }
    }
    revisionWaitersRef.current = waiting
    ready.forEach((resolve) => resolve())
  }, [snapshot.revision])

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      const pending = revisionWaitersRef.current.splice(0)
      pending.forEach(({ resolve }) => resolve())
    }
  }, [])

  const waitForSnapshotRevision = (minimumRevision: number): Promise<void> => {
    if (
      !activeRef.current ||
      snapshotRevisionRef.current >= minimumRevision
    ) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      revisionWaitersRef.current.push({ minimumRevision, resolve })
    })
  }

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
    const descriptor = fieldDescriptor(fieldPath)
    if (descriptor?.dynamicOptions === 'ready-providers') {
      return snapshot.global.providers
        .filter((p) => p.status === 'ready')
        .map((p) => ({ value: p.providerId as string, label: p.displayName }))
    }
    if (descriptor?.dynamicOptions === 'connections') {
      return [
        { value: '', label: '无连接' },
        ...snapshot.global.connections.map((c) => ({
          value: c.connectionId as string,
          label: c.label
        }))
      ]
    }
    return [...(descriptor?.options ?? [])]
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
  ): Promise<CommandResult> => {
    setFeedback(null)
    setPendingStageCount((count) => count + 1)
    const request = stageTailRef.current.then(async () => {
      const result = await sendCommand({
        kind: 'stage-configuration',
        owner,
        fieldPath,
        value
      })
      if (result.ok) {
        await waitForSnapshotRevision(result.acceptedRevision)
      } else {
        if (result.reason === 'stale-revision') {
          await waitForSnapshotRevision(result.latestRevision)
        }
        if (activeRef.current) {
          setFeedback({ kind: 'alert', message: result.message })
        }
      }
      return result
    })
    const tail = request.then(
      () => undefined,
      () => undefined
    )
    stageTailRef.current = tail
    void tail.then(() => {
      if (activeRef.current) {
        setPendingStageCount((count) => count - 1)
      }
    })
    return request
  }

  // Drafts shown, applied or discarded here are scoped to THIS project —
  // another project's drafts never leak into its Settings (US-67).
  const isCurrentProjectOwner = (owner: ConfigurationOwner): boolean =>
    owner.kind === 'project'
      ? owner.projectId === project.projectId
      : projectAgents.some((a) => a.agentInstanceId === owner.agentInstanceId)

  const draftsWithChanges = snapshot.configurationDrafts.filter(
    (d) => d.changes.length > 0 && isCurrentProjectOwner(d.owner)
  )

  useEffect(() => {
    if (!applyAttempt || snapshot.revision < applyAttempt.acceptedRevision) {
      return
    }
    const allApplied = applyAttempt.owners.every((target) =>
      snapshot.appliedConfigurations.some(
        (applied) =>
          ownerKey(applied.owner) === target.ownerKey &&
          applied.appliedVersion >= target.targetAppliedVersion
      )
    )
    const pendingOwner = snapshot.configurationDrafts.some((draft) =>
      applyAttempt.owners.some(
        (target) => target.ownerKey === ownerKey(draft.owner)
      )
    )
    if (allApplied) {
      setFeedback({
        kind: 'status',
        message: `已应用 ${applyAttempt.ownerCount} 个 owner 的配置变更`
      })
      setApplyAttempt(null)
      return
    }
    if (snapshot.pendingConfirmation && pendingOwner) {
      setFeedback({
        kind: 'status',
        message: '配置尚未应用，正在等待确认集成绑定影响'
      })
      return
    }
    setFeedback(
      pendingOwner
        ? { kind: 'status', message: '已取消确认，配置草稿仍保留' }
        : { kind: 'alert', message: '配置未应用；草稿已取消或失效' }
    )
    setApplyAttempt(null)
  }, [applyAttempt, snapshot])

  const confirmApply = async () => {
    if (pendingStageCount > 0) {
      setFeedback({
        kind: 'alert',
        message: '仍有修改正在暂存，请等待完成后再应用'
      })
      return
    }
    // The concurrency baseline is the version the DRAFT was captured at —
    // never the latest applied value, which would let a stale draft
    // overwrite a newer applied truth.
    const owners = draftsWithChanges.map((d) => ({
      owner: d.owner,
      expectedAppliedVersion: d.appliedVersion
    }))
    const result = await sendCommand({ kind: 'apply-configuration', owners })
    // Close after every decision: a rejection refreshes the drafts with
    // validation errors, and re-opening rebuilds the summary from the
    // latest rendered snapshot.
    setShowApplyDialog(false)
    if (result.ok) {
      setApplyAttempt({
        acceptedRevision: result.acceptedRevision,
        owners: owners.map(({ owner, expectedAppliedVersion }) => ({
          ownerKey: ownerKey(owner),
          targetAppliedVersion: expectedAppliedVersion + 1
        })),
        ownerCount: owners.length
      })
    } else {
      setApplyAttempt(null)
      setFeedback({ kind: 'alert', message: result.message })
    }
  }

  // Settings C deep links (#14): a blocker link only ever sends the user to
  // the single location that can clear it — a Settings A section (selecting
  // the instance when the blocker names one) or the global Provider Health
  // surface. The summary itself edits nothing.
  const openReadinessTarget = (target: RunReadinessBlockerTarget): void => {
    if (target.kind === 'provider-health') {
      void sendCommand({ kind: 'navigate-global', surface: 'provider-health' })
      return
    }
    setSection(target.section)
    if (target.section === 'instances' && target.agentInstanceId) {
      setSelectedAgentId(target.agentInstanceId)
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
            key={`${ownerKey(owner)}:${fieldPath}`}
            fieldPath={fieldPath}
            descriptor={fieldDescriptor(fieldPath)!}
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
        className="w-40 shrink-0 space-y-0.5 border-r border-line pr-3"
      >
        {EDIT_SECTIONS.map(({ key, label }) => (
          <button
            key={key}
            aria-current={section === key ? 'page' : undefined}
            className={`block w-full rounded px-2 py-1 text-left text-sm ${
              section === key
                ? 'bg-wash font-medium text-ink'
                : 'text-muted hover:bg-wash hover:text-ink'
            }`}
            onClick={() => setSection(key)}
          >
            {label}
          </button>
        ))}
        <p className="section-label px-2 pt-2">
          只读视图
        </p>
        {READONLY_SECTIONS.map(({ key, label }) => (
          <button
            key={key}
            aria-current={section === key ? 'page' : undefined}
            className={`block w-full rounded px-2 py-1 text-left text-sm ${
              section === key
                ? 'bg-wash font-medium text-ink'
                : 'text-muted hover:bg-wash hover:text-ink'
            }`}
            onClick={() => setSection(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-auto pr-2">
        <p className="mb-4 text-xs text-muted">
          布局、当前工作面与过滤器会自动保存；以下配置需点击应用后生效。
        </p>

        {section === 'general' && (
          <div>
            <p className="mb-3 text-xs text-muted">
              根目录：{ROOT_LABEL[project.rootAvailability]} · Git：
              {GIT_LABEL[project.repositoryReadiness]}
            </p>
            {renderFieldRows(projectOwner, PROJECT_SECTION_FIELDS.general)}
          </div>
        )}

        {section === 'defaults' && (
          <div>
            <p className="mb-3 text-xs text-muted">
              默认配置只影响之后创建的实例，不追溯修改现有实例。
            </p>
            {renderFieldRows(projectOwner, PROJECT_SECTION_FIELDS.defaults)}
          </div>
        )}

        {section === 'instances' && (
          <div>
            <label className="mb-3 block text-xs text-muted">
              选择实例
              <select
                aria-label="选择实例"
                className="mt-1 block w-64 rounded border border-line bg-paper px-2 py-1 text-sm text-ink"
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
              <p className="mb-3 text-xs text-amber">
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
            <p className="mt-4 text-xs text-muted">
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
            {/* Enforcement truth (#14): only the adapter-judged effective
                status is shown. Phase 1 has no PermissionBroker, so a
                recorded policy is intent only and renders as blocked —
                never as enforced. The editing rows above stay the editor. */}
            <div className="mt-4">
              <h3 className="text-xs font-medium text-ink">
                生效状态（只读）
              </h3>
              <ul className="mt-2 space-y-2">
                {PROJECT_SECTION_FIELDS.permissions.map((fieldPath) => {
                  const entry = snapshot.effectiveConfigurations
                    .find((c) => ownerKey(c.owner) === ownerKey(projectOwner))
                    ?.entries.find((e) => e.fieldPath === fieldPath)
                  if (!entry) return null
                  return (
                    <li key={fieldPath} className="text-xs">
                      <span className="text-muted">
                        {fieldDescriptor(fieldPath)?.label ?? fieldPath}：
                        {formatValue(fieldPath, entry.applied)}
                      </span>
                      <span
                        className={
                          entry.status === 'blocked'
                            ? 'ml-2 text-amber'
                            : 'ml-2 text-teal'
                        }
                      >
                        {entry.status === 'blocked' ? '已阻止' : '可生效'}
                      </span>
                      {entry.status === 'blocked' && entry.blockedReason && (
                        <p className="mt-0.5 text-muted">
                          {entry.blockedReason}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        )}

        {section === 'storage' && (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted">
              本地数据仅保存在本机，滚动快照随 schema 版本保留；凭据、Token
              与 Cookie 不进入 Project 数据。
            </p>
            <div className="flex gap-2">
              <button
                className="mini-button disabled:cursor-not-allowed"
                disabled
                title="导出将在后续版本提供"
              >
                导出
              </button>
              <button
                className="mini-button disabled:cursor-not-allowed"
                disabled
                title="导入将在后续版本提供"
              >
                导入
              </button>
            </div>
          </div>
        )}

        {section === 'matrix' && (
          <div>
            <p className="mb-3 text-xs text-muted">
              只读比较视图 · 编辑请回到上方对应设置。
            </p>
            <PolicyMatrix
              agents={projectAgents}
              snapshot={snapshot}
              formatValue={formatValue}
            />
          </div>
        )}

        {section === 'readiness' && (
          <div>
            <p className="mb-3 text-xs text-muted">
              只读摘要 · 下一次 Run 的就绪状态由 adapter
              汇总；配置编辑请回到上方对应设置。
            </p>
            <ReadinessSummary
              agents={projectAgents}
              snapshot={snapshot}
              onOpenTarget={openReadinessTarget}
            />
          </div>
        )}
      </div>

      <aside
        aria-label="待应用摘要"
        aria-busy={pendingStageCount > 0}
        className="flex w-72 shrink-0 flex-col rounded-lg border border-line bg-paper p-3"
      >
        <h3 className="mb-2 text-sm font-medium text-ink">待应用摘要</h3>
        {draftsWithChanges.length === 0 ? (
          <p className="text-xs text-muted">暂无待应用变更</p>
        ) : (
          <ul className="min-h-0 flex-1 space-y-2 overflow-auto">
            {draftsWithChanges.map((draft) => {
              const label = ownerLabel(draft.owner)
              return (
                <li
                  key={ownerKey(draft.owner)}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="text-ink">
                    {label}：{draft.changes.length} 项变更
                  </span>
                  <button
                    aria-label={`丢弃「${label}」的草稿`}
                    className="rounded px-1.5 py-0.5 text-muted hover:bg-wash hover:text-ink"
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
          className="btn btn-primary mt-3"
          disabled={
            draftsWithChanges.length === 0 || pendingStageCount > 0
          }
          onClick={() => {
            setFeedback(null)
            setShowApplyDialog(true)
          }}
        >
          应用全部变更
        </button>
        {pendingStageCount > 0 && (
          <p role="status" className="mt-2 text-xs text-muted">
            正在暂存 {pendingStageCount} 项修改…
          </p>
        )}
        {feedback && (
          <p
            role={feedback.kind === 'alert' ? 'alert' : 'status'}
            className={`mt-2 text-xs ${
              feedback.kind === 'alert' ? 'text-danger' : 'text-teal'
            }`}
          >
            {feedback.message}
          </p>
        )}
      </aside>

      {showApplyDialog && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-backdrop">
          <div
            role="dialog"
            aria-label="应用配置变更"
            className="w-full max-w-lg space-y-3 rounded-[11px] border border-line bg-paper p-4 shadow-overlay"
          >
            <h3 className="text-sm font-medium text-ink">
              应用配置变更
            </h3>
            <p className="text-xs text-muted">
              以下变更将原子提交：任一验证失败都不会修改任何 applied 配置。
            </p>
            <ul className="max-h-64 space-y-1.5 overflow-auto text-xs">
              {draftsWithChanges.flatMap((draft) =>
                draft.changes.map((change) => (
                  <li
                    key={`${ownerKey(draft.owner)}:${change.fieldPath}`}
                    className="text-ink"
                  >
                    {ownerLabel(draft.owner)} ·{' '}
                    {fieldDescriptor(change.fieldPath)?.label ??
                      change.fieldPath}
                    ：
                    {formatValue(change.fieldPath, change.applied)} →{' '}
                    {formatValue(change.fieldPath, change.draft)}
                  </li>
                ))
              )}
            </ul>
            <div className="flex justify-end gap-2">
              <button
                className="btn btn-ghost"
                onClick={() => setShowApplyDialog(false)}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={pendingStageCount > 0}
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
  descriptor,
  appliedValue,
  appliedVersion,
  draftChange,
  error,
  options,
  formatValue,
  onStage
}: {
  fieldPath: string
  descriptor: ConfigurationFieldDescriptor
  appliedValue: unknown
  appliedVersion: number
  draftChange?: { fieldPath: string; applied: unknown; draft: unknown }
  error?: string
  options: Array<{ value: string; label: string }>
  formatValue: (value: unknown) => string
  onStage: (value: unknown) => Promise<CommandResult>
}) {
  const shown =
    draftChange !== undefined
      ? String(draftChange.draft ?? '')
      : String(appliedValue ?? '')
  const [value, setValue] = useState(shown)
  const [pendingAttemptCount, setPendingAttemptCount] = useState(0)
  const shownRef = useRef(shown)
  const stageAttemptRef = useRef(0)
  shownRef.current = shown
  // Re-sync only when the underlying truth (draft or applied) changes —
  // in-progress typing is local and survives unrelated or intermediate stage
  // events. The latest queued edit remains visible until it settles.
  useEffect(() => {
    if (pendingAttemptCount === 0) setValue(shown)
  }, [shown, pendingAttemptCount])

  const commitStage = async (nextValue: unknown) => {
    const attempt = ++stageAttemptRef.current
    setPendingAttemptCount((count) => count + 1)
    try {
      const result = await onStage(nextValue)
      if (!result.ok && attempt === stageAttemptRef.current) {
        setValue(shownRef.current)
      }
    } finally {
      setPendingAttemptCount((count) => count - 1)
    }
  }

  return (
    <li className="space-y-1">
      <div className="flex items-center gap-3">
        <span className="w-32 shrink-0 text-xs text-muted">
          {descriptor.label}
        </span>
        {descriptor.kind === 'select' ? (
          <select
            aria-label={descriptor.label}
            className="w-64 rounded border border-line bg-paper px-2 py-1 text-sm text-ink"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              void commitStage(
                fieldPath === 'integrations.primaryConnectionId' &&
                  e.target.value === ''
                  ? null
                  : e.target.value
              )
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={descriptor.label}
            className="w-64 rounded border border-line bg-paper px-2 py-1 text-sm text-ink"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => {
              if (value === shown && pendingAttemptCount === 0) return
              void commitStage(
                descriptor.kind === 'number' ? Number(value) : value
              )
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        )}
        <span className="chip">
          {TIMING_LABEL[descriptor.timing]}
        </span>
      </div>
      <div className="flex items-center gap-3 pl-[8.75rem] text-xs">
        <span className="text-muted">
          当前：{formatValue(appliedValue)}（v{appliedVersion}）
        </span>
        {draftChange && (
          <span className="text-amber">
            待应用：{formatValue(draftChange.draft)}
          </span>
        )}
      </div>
      {error && <p className="pl-[8.75rem] text-xs text-danger">{error}</p>}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Settings B — policy matrix: read-only applied/effective comparison (#14)
// ---------------------------------------------------------------------------

/** Matrix rows: every agent-scoped catalogue field except the identity name. */
const MATRIX_FIELD_PATHS = AGENT_FIELD_PATHS.filter(
  (fieldPath) => fieldPath !== 'identity.name'
)

function PolicyMatrix({
  agents,
  snapshot,
  formatValue
}: {
  agents: AgentInstanceViewModel[]
  snapshot: WorkbenchViewModel
  formatValue: (fieldPath: string, value: unknown) => string
}) {
  if (agents.length === 0) {
    return (
      <p className="text-sm text-muted">
        当前 Project 尚无 Agent 实例，暂无可比较的配置。
      </p>
    )
  }
  if (agents.length === 1) {
    return (
      <p className="text-sm text-muted">
        当前 Project 只有 1 个 Agent 实例，策略矩阵需要至少 2
        个实例进行比较。
      </p>
    )
  }

  const appliedFor = (agent: AgentInstanceViewModel) =>
    snapshot.appliedConfigurations.find(
      (c) =>
        c.owner.kind === 'agent' &&
        c.owner.agentInstanceId === agent.agentInstanceId
    )
  const effectiveEntryFor = (
    agent: AgentInstanceViewModel,
    fieldPath: string
  ) =>
    snapshot.effectiveConfigurations
      .find(
        (c) =>
          c.owner.kind === 'agent' &&
          c.owner.agentInstanceId === agent.agentInstanceId
      )
      ?.entries.find((entry) => entry.fieldPath === fieldPath)

  return (
    <table className="border-collapse text-sm">
      <thead>
        <tr>
          <th
            scope="col"
            className="border-b border-line px-2 py-1.5 text-left text-xs font-normal text-muted"
          >
            配置项
          </th>
          {agents.map((agent) => (
            <th
              key={agent.agentInstanceId}
              scope="col"
              className="border-b border-line px-2 py-1.5 text-left"
            >
              <span className="block font-medium text-ink">
                {agent.name}
              </span>
              <span className="block text-xs font-normal text-muted">
                {providerLabel(agent.providerId)}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {MATRIX_FIELD_PATHS.map((fieldPath) => (
          <tr key={fieldPath}>
            <th
              scope="row"
              className="whitespace-nowrap border-b border-line px-2 py-1.5 text-left text-xs font-normal text-muted"
            >
              {fieldDescriptor(fieldPath)?.label ?? fieldPath}
            </th>
            {agents.map((agent) => {
              const value = appliedFor(agent)?.values[fieldPath]
              const entry = effectiveEntryFor(agent, fieldPath)
              const blocked = entry?.status === 'blocked'
              return (
                <td
                  key={agent.agentInstanceId}
                  className="border-b border-line px-2 py-1.5 align-top text-ink"
                >
                  <span>
                    {value === undefined || value === null || value === ''
                      ? '未设置'
                      : formatValue(fieldPath, value)}
                  </span>
                  {blocked && (
                    <span className="mt-0.5 block text-xs text-amber">
                      已阻止：{entry.blockedReason}
                    </span>
                  )}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------------------
// Settings C — next-Run readiness: read-only adapter summary (#14)
// ---------------------------------------------------------------------------

function ReadinessSummary({
  agents,
  snapshot,
  onOpenTarget
}: {
  agents: AgentInstanceViewModel[]
  snapshot: WorkbenchViewModel
  onOpenTarget: (target: RunReadinessBlockerTarget) => void
}) {
  const targetLabel = (target: RunReadinessBlockerTarget): string =>
    target.kind === 'provider-health'
      ? '前往 Provider 健康'
      : `前往「${SECTIONS.find((s) => s.key === target.section)?.label ?? target.section}」设置`

  return (
    <div>
      <ul className="space-y-2">
        {agents.map((agent) => {
          const readiness = snapshot.runReadiness.find(
            (r) => r.agentInstanceId === agent.agentInstanceId
          )
          if (!readiness) return null
          return (
            <li
              key={agent.agentInstanceId}
              className="rounded-lg border border-line bg-paper px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink">
                  {agent.name}
                </span>
                <span className="text-xs text-muted">
                  {providerLabel(agent.providerId)}
                </span>
                <span
                  className={`text-xs ${
                    readiness.status === 'ready'
                      ? 'text-teal'
                      : 'text-amber'
                  }`}
                >
                  {readiness.status === 'ready' ? '就绪' : '已阻止'}
                </span>
              </div>
              {readiness.blockers.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {readiness.blockers.map((blocker, index) => (
                    <li
                      key={index}
                      className="flex items-center gap-2 text-xs text-muted"
                    >
                      <span>{blocker.message}</span>
                      {blocker.target && (
                        <button
                          className="text-brand hover:underline"
                          onClick={() => onOpenTarget(blocker.target!)}
                        >
                          {targetLabel(blocker.target)}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-[11px] text-muted">
        演示模式：Readiness 汇总基于 mock 场景；权限策略尚未接入
        PermissionBroker，Readiness 不代表真实强制能力。
      </p>
    </div>
  )
}
