import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  AgentInstanceViewModel,
  AgentProviderId,
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
import {
  RUNTIME_STATE_LABEL,
  WORKTREE_MODE_LABEL,
  providerLabel
} from './agent-display'
import { StatusDot, statusDotState } from './status-dot'
import { ProviderIcon } from './provider-icon'
import { CONNECTION_STATUS_LABEL } from './connection-display'
import type { SendCommand } from './agents-surface'

/**
 * Settings A — the single full configuration editor (#13), plus the two
 * read-only views (#14): the policy matrix (B) and the readiness summary (C).
 *
 * #68 aligns the surface with the frozen 层级配置台 baseline (variants
 * A/B/C of project-integrations-settings-desktop-b.html): a top 放弃/应用
 * action bar, an icon catalog plus Agent instance list on the left,
 * sectioned form cards in the middle, and the sticky 待应用摘要 on the
 * right. The prototype's toggles are deliberately absent — the shared
 * field catalogue (`CONFIGURATION_FIELDS`) defines no boolean field, so
 * rendering one would fabricate a control with no data backing.
 *
 * Editing only ever stages drafts through the port; applied truth, active
 * Runs and identity change solely via an explicit atomic apply. The
 * renderer owns no configuration rules: values, versions, drafts and
 * validation errors all come from the WorkbenchViewModel. The read-only
 * views render adapter-computed `effectiveConfigurations` / `runReadiness`
 * and only ever link back to the editing sections or the global Provider
 * Health surface.
 */

const TIMING_LABEL: Record<ConfigurationFieldTiming, string> = {
  immediate: '立即生效',
  'next-run': '下一 Run 生效',
  'new-agent': '新建 Agent 生效'
}

const EDIT_SECTIONS = [
  {
    key: 'general',
    label: '常规',
    icon: '◎',
    description: '名称、根目录与生命周期'
  },
  {
    key: 'defaults',
    label: 'Agent 默认配置',
    icon: '◇',
    description: '仅作为创建初始值'
  },
  {
    key: 'instances',
    label: 'Agent 实例',
    icon: '⌘',
    description: '逐实例配置与状态'
  },
  {
    key: 'integrations',
    label: '集成',
    icon: '⇄',
    description: '飞书连接与资源范围'
  },
  {
    key: 'permissions',
    label: '权限',
    icon: '◈',
    description: '可强制执行的有效权限'
  },
  {
    key: 'storage',
    label: '存储',
    icon: '▣',
    description: '本地数据、备份与导出'
  }
] as const

// Settings B/C (#14): read-only comparison and summary views. They own no
// editing or navigation logic — every edit path leads back to the sections
// above, which remain the single edit locations.
const READONLY_SECTIONS = [
  {
    key: 'matrix',
    label: '策略矩阵',
    icon: '▦',
    description: '跨实例比较有效配置'
  },
  {
    key: 'readiness',
    label: 'Readiness 摘要',
    icon: '✓',
    description: '按风险与运行边界组织'
  }
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

/** Instance form groups of the frozen variant A (#68): identity + runtime,
 *  workspace, then environment. Field order inside a group follows the
 *  catalogue; the groups themselves are presentation-only. */
const INSTANCE_IDENTITY_FIELDS = [
  'identity.name',
  'model.id',
  'concurrency.priority'
]
const INSTANCE_ENVIRONMENT_FIELDS = [
  'proxy.http',
  'env.custom',
  'budget.maxTokens'
]

/**
 * Per-field helper copy for the label column. Pure UI text — the business
 * facts (kind, options, timing) still come from the shared catalogue.
 */
const FIELD_DESCRIPTION: Record<string, string> = {
  'general.name': '工作台中的可见名称。',
  'general.landingSurface': '进入 Project 时默认打开的工作面。',
  'defaults.providerId': '只列出 Doctor 通过的 Provider；仅作为创建初始值。',
  'defaults.model': '创建实例时的初始模型，不追溯修改现有实例。',
  'defaults.openMode': '创建后保持 Ready，不自动启动 Run。',
  'defaults.worktreeMode':
    '创建实例时的初始隔离模式；共享可写 cwd 永不允许。',
  'integrations.primaryConnectionId':
    '连接属于 App，Project 只保存 0..1 个主连接。',
  'integrations.resourceScope':
    'Agent 可请求的飞书资源范围；应用后影响下一次 Run。',
  'permissions.defaultPolicy':
    '临时允许只支持「一次」或「当前 Run」；超时默认拒绝。',
  'identity.name': 'Project 内唯一；应用前路由仍使用原名。',
  'model.id': '应用后只影响下一次 Run，不重启当前 Run。',
  'proxy.http': '按实例配置，不从 Project 默认值继承。',
  'env.custom': '仅注入当前实例，应用后对下一次 Run 生效。',
  'concurrency.priority': '排队时的相对优先级；应用后影响下一次 Run。',
  'budget.maxTokens': '单个 Run 的 Token 上限；应用后影响下一次 Run。'
}

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
  const totalChanges = draftsWithChanges.reduce(
    (count, draft) => count + draft.changes.length,
    0
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

  // The top action bar is the single place that applies or abandons every
  // staged draft of this Project (#68); the right rail only summarizes.
  const discardAllDrafts = (): void => {
    setFeedback(null)
    void sendCommand({
      kind: 'discard-configuration',
      owners: draftsWithChanges.map((d) => d.owner)
    })
  }

  const renderFieldRows = (owner: ConfigurationOwner, fieldPaths: string[]) => {
    const applied = appliedFor(owner)
    const draft = draftFor(owner)
    if (!applied) return null
    return (
      <ul className="space-y-1">
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

  const activeSectionMeta = SECTIONS.find((s) => s.key === section)!
  const readyAgentCount = projectAgents.filter(
    (agent) =>
      snapshot.runReadiness.find(
        (r) => r.agentInstanceId === agent.agentInstanceId
      )?.status === 'ready'
  ).length
  // The integrations badge restates the adapter-owned health of the APPLIED
  // primary connection. A configured binding alone never implies 已连接 —
  // the same fact the Connections surface renders (#6).
  const primaryConnection = snapshot.global.connections.find(
    (c) =>
      c.connectionId ===
      appliedFor(projectOwner)?.values['integrations.primaryConnectionId']
  )

  // Detail-head badge of the frozen variant A: a scope tag for catalog
  // sections, the Doctor fact for a selected instance (#68), the readiness
  // count for the review page. Never a renderer-derived judgment.
  const detailBadge = ((): ReactNode => {
    if (section === 'instances') {
      if (selectedAgent) {
        return (
          <span
            className={`chip ${
              selectedAgent.doctor === 'ready' ? 'chip-good' : 'chip-warn'
            }`}
          >
            Doctor {selectedAgent.doctor === 'ready' ? '通过' : '未通过'}
          </span>
        )
      }
      return <DetailBadge>{projectAgents.length} 个实例</DetailBadge>
    }
    if (section === 'integrations') {
      return (
        <DetailBadge>
          {primaryConnection
            ? `${primaryConnection.label}：${
                CONNECTION_STATUS_LABEL[primaryConnection.status]
              }`
            : '未连接'}
        </DetailBadge>
      )
    }
    if (section === 'readiness') {
      return (
        <span className="chip chip-good">{readyAgentCount} 个 Agent 可运行</span>
      )
    }
    if (section === 'matrix') return null
    const badge: Record<string, string> = {
      general: 'Project 作用域',
      defaults: '创建初始值',
      permissions: '强制执行',
      storage: '仅本地'
    }
    return badge[section] ? <DetailBadge>{badge[section]}</DetailBadge> : null
  })()

  const detailHead: {
    icon: string
    providerId?: AgentProviderId
    title: string
    note: string
  } = (() => {
    if (section === 'instances' && selectedAgent) {
      return {
        icon: '',
        providerId: selectedAgent.providerId,
        title: selectedAgent.name,
        note: `${providerLabel(selectedAgent.providerId)} · ${
          RUNTIME_STATE_LABEL[selectedAgent.runtimeState]
        }`
      }
    }
    if (section === 'readiness') {
      return {
        icon: activeSectionMeta.icon,
        title: '运行前安全审阅',
        note: '只读摘要：下一次 Run 的就绪状态由 adapter 汇总；配置编辑请回到对应设置。'
      }
    }
    if (section === 'matrix') {
      return {
        icon: activeSectionMeta.icon,
        title: 'Agent 策略矩阵',
        note: '只读比较视图：横向比较 applied 配置与有效状态；编辑请回到对应设置。'
      }
    }
    return {
      icon: activeSectionMeta.icon,
      title: activeSectionMeta.label,
      note:
        section === 'instances'
          ? 'Provider Doctor 通过后才能创建实例；未通过时配置仍可暂存'
          : activeSectionMeta.description
    }
  })()

  return (
    <section
      role="region"
      aria-label="项目设置"
      className="flex h-full min-h-0 flex-col"
    >
      {/* Top action bar of the frozen variant A (#68): the draft/applied
          boundary copy, the pending count and the single 放弃/应用 pair. */}
      <div className="flex min-h-[46px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-paper px-4 py-1.5">
        <p className="min-w-0 text-[10px] text-muted">
          布局、当前工作面与过滤器会自动保存；以下配置需点击应用后生效。
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-[10px] text-muted">
            {totalChanges > 0 ? `${totalChanges} 项待应用` : '配置已应用'}
          </span>
          <button
            className="btn btn-ghost"
            disabled={draftsWithChanges.length === 0 || pendingStageCount > 0}
            onClick={discardAllDrafts}
          >
            放弃全部变更
          </button>
          <button
            className="btn btn-primary"
            disabled={draftsWithChanges.length === 0 || pendingStageCount > 0}
            onClick={() => {
              setFeedback(null)
              setShowApplyDialog(true)
            }}
          >
            应用全部变更
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="设置目录"
          className="w-[238px] shrink-0 space-y-4 overflow-y-auto border-r border-line bg-raised p-2.5"
        >
          <div>
            <p className="section-label px-1.5 pb-1.5">Project Settings</p>
            <div className="space-y-1">
              {EDIT_SECTIONS.map(({ key, label, icon, description }) => (
                <NavItem
                  key={key}
                  label={label}
                  icon={icon}
                  description={description}
                  active={section === key}
                  onClick={() => setSection(key)}
                />
              ))}
            </div>
          </div>
          <div>
            <p className="section-label px-1.5 pb-1.5">只读视图</p>
            <div className="space-y-1">
              {READONLY_SECTIONS.map(({ key, label, icon, description }) => (
                <NavItem
                  key={key}
                  label={label}
                  icon={icon}
                  description={description}
                  active={section === key}
                  onClick={() => setSection(key)}
                />
              ))}
            </div>
          </div>
          <div>
            <p className="section-label px-1.5 pb-1.5">Agent Instances</p>
            {projectAgents.length === 0 ? (
              <p className="px-1.5 text-[9px] text-muted">
                当前 Project 尚无 Agent 实例
              </p>
            ) : (
              <div className="space-y-1">
                {projectAgents.map((agent) => (
                  <button
                    key={agent.agentInstanceId}
                    type="button"
                    aria-current={
                      section === 'instances' &&
                      selectedAgentId === agent.agentInstanceId
                        ? 'page'
                        : undefined
                    }
                    className={`grid w-full grid-cols-[27px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border px-1.5 py-[5px] text-left ${
                      section === 'instances' &&
                      selectedAgentId === agent.agentInstanceId
                        ? 'border-brand-border bg-paper shadow-lift'
                        : 'border-transparent hover:bg-paper'
                    }`}
                    onClick={() => {
                      setSelectedAgentId(agent.agentInstanceId)
                      setSection('instances')
                    }}
                  >
                    <ProviderIcon providerId={agent.providerId} size={27} />
                    <span className="min-w-0">
                      <strong className="block truncate text-[10px] font-semibold text-ink">
                        {agent.name}
                      </strong>
                      {/* The state sublabel names the state, so the dot
                          stays decorative (#65 double-coding). */}
                      <small className="block truncate text-[8px] text-muted">
                        {providerLabel(agent.providerId)} ·{' '}
                        {RUNTIME_STATE_LABEL[agent.runtimeState]}
                      </small>
                    </span>
                    <StatusDot state={statusDotState(agent.runtimeState)} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>

        <div className="min-w-0 flex-1 overflow-auto">
          <header className="sticky top-0 z-10 flex min-h-[60px] items-center gap-3 border-b border-line bg-paper/95 px-5 py-2 backdrop-blur-sm">
            {detailHead.providerId ? (
              <ProviderIcon providerId={detailHead.providerId} size={38} className="shrink-0" />
            ) : (
              <span
                aria-hidden="true"
                className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-brand-soft font-mono text-sm font-bold text-brand"
              >
                {detailHead.icon}
              </span>
            )}
            <span className="min-w-0">
              <h2 className="truncate text-[17px] font-semibold text-ink">
                {detailHead.title}
              </h2>
              <p className="mt-0.5 truncate text-[9px] text-muted">
                {detailHead.note}
              </p>
            </span>
            {detailBadge && <span className="ml-auto shrink-0">{detailBadge}</span>}
          </header>

          <div className="mx-auto max-w-[880px] px-5 pb-16">
            {section === 'general' && (
              <FormBlock>
                {renderFieldRows(projectOwner, PROJECT_SECTION_FIELDS.general)}
                <ul className="mt-1 space-y-1">
                  <ReadonlyFieldRow
                    label="ProjectId"
                    description="稳定身份，不随路径变化。"
                    value={project.projectId}
                    note="只读"
                  />
                  <ReadonlyFieldRow
                    label="根目录"
                    description="不能像普通文本字段一样修改。"
                    value={project.rootPath ?? '—'}
                    note={ROOT_LABEL[project.rootAvailability]}
                  />
                  <ReadonlyFieldRow
                    label="Git 状态"
                    description="非 Git Project 可以管理任务与知识，但不能创建可运行 Agent。"
                    value={GIT_LABEL[project.repositoryReadiness]}
                    note={project.currentBranch ?? ''}
                  />
                </ul>
              </FormBlock>
            )}

            {section === 'defaults' && (
              <FormBlock note="默认值只在创建时复制，不追溯修改现有实例；代理、凭据与自定义环境变量永不继承。">
                {renderFieldRows(projectOwner, PROJECT_SECTION_FIELDS.defaults)}
              </FormBlock>
            )}

            {section === 'instances' &&
              (selectedAgent && selectedOwner ? (
                <>
                  {selectedAgent.doctor === 'blocked' && (
                    <p className="notice-bar notice-bar-danger mt-3">
                      {providerLabel(selectedAgent.providerId)} Provider Doctor
                      未通过：不能启动或重启 Run，修复后原位恢复。配置仍可暂存，
                      但进行中的 Run 不受影响。
                    </p>
                  )}
                  {selectedAgent.activeRunConfigVersion !== undefined && (
                    <p className="mt-3 text-[10px] text-amber">
                      当前 Run 配置快照：v
                      {selectedAgent.activeRunConfigVersion}
                      （应用不影响进行中的 Run）
                    </p>
                  )}
                  <FormBlock title="身份与运行配置">
                    {renderFieldRows(
                      selectedOwner,
                      INSTANCE_IDENTITY_FIELDS.slice(0, 1)
                    )}
                    <ul className="mt-1 space-y-1">
                      <ReadonlyFieldRow
                        label="AgentInstanceId"
                        description="稳定身份，不因重命名或 Tab 移动改变。"
                        value={selectedAgent.agentInstanceId}
                        note="只读"
                      />
                      <ReadonlyFieldRow
                        label="Provider"
                        description="更换 Provider 必须新建实例并执行 handoff。"
                        value={providerLabel(selectedAgent.providerId)}
                        note="不可修改"
                      />
                    </ul>
                    {renderFieldRows(
                      selectedOwner,
                      INSTANCE_IDENTITY_FIELDS.slice(1)
                    )}
                  </FormBlock>
                  <FormBlock title="工作区与进程">
                    <ul className="space-y-1">
                      <ReadonlyFieldRow
                        label="工作区模式"
                        description="写入型 Agent 始终使用独立 worktree。"
                        value={
                          WORKTREE_MODE_LABEL[selectedAgent.worktreeMode]
                        }
                        note="共享可写 cwd 永不允许"
                      />
                    </ul>
                  </FormBlock>
                  <FormBlock title="实例环境">
                    {renderFieldRows(
                      selectedOwner,
                      INSTANCE_ENVIRONMENT_FIELDS
                    )}
                  </FormBlock>
                </>
              ) : (
                <p className="py-4 text-sm text-muted">
                  当前 Project 尚无 Agent 实例。
                </p>
              ))}

            {section === 'integrations' && (
              <>
                <FormBlock>
                  {renderFieldRows(
                    projectOwner,
                    PROJECT_SECTION_FIELDS.integrations
                  )}
                </FormBlock>
                <p className="notice-bar mt-3">
                  切换或移除主连接前会要求确认失效绑定与权限差异；v0.2
                  最多一个主连接。
                </p>
                <p className="mt-3 text-[9px] text-muted">
                  人工浏览器身份与 Connector 执行身份相互隔离；连接凭据不会进入
                  Project 配置或导出内容。
                </p>
              </>
            )}

            {section === 'permissions' && (
              <>
                <p className="notice-bar mt-3">
                  强制执行原则：如果 Provider
                  或主机无法真正落实所选限制，Run
                  默认被阻止；原生 bypass/auto-approve 不算「已落实」。
                </p>
                <FormBlock>
                  {renderFieldRows(
                    projectOwner,
                    PROJECT_SECTION_FIELDS.permissions
                  )}
                </FormBlock>
                {/* Enforcement truth (#14): only the adapter-judged effective
                    status is shown. Phase 1 has no PermissionBroker, so a
                    recorded policy is intent only and renders as blocked —
                    never as enforced. The editing rows above stay the editor. */}
                <FormBlock title="生效状态（只读）">
                  <ul className="space-y-1.5">
                    {PROJECT_SECTION_FIELDS.permissions.map((fieldPath) => {
                      const entry = snapshot.effectiveConfigurations
                        .find(
                          (c) => ownerKey(c.owner) === ownerKey(projectOwner)
                        )
                        ?.entries.find((e) => e.fieldPath === fieldPath)
                      if (!entry) return null
                      return (
                        <li
                          key={fieldPath}
                          className="flex items-start justify-between gap-3"
                        >
                          <span className="text-[10px] text-ink">
                            {fieldDescriptor(fieldPath)?.label ?? fieldPath}：
                            {formatValue(fieldPath, entry.applied)}
                            {entry.status === 'blocked' &&
                              entry.blockedReason && (
                                <span className="mt-0.5 block text-[9px] text-muted">
                                  {entry.blockedReason}
                                </span>
                              )}
                          </span>
                          <span
                            className={`chip shrink-0 ${
                              entry.status === 'blocked'
                                ? 'chip-warn'
                                : 'chip-good'
                            }`}
                          >
                            {entry.status === 'blocked' ? '已阻止' : '可生效'}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </FormBlock>
              </>
            )}

            {section === 'storage' && (
              <FormBlock note="本地数据仅保存在本机，滚动快照随 schema 版本保留；凭据、Token 与 Cookie 不进入 Project 数据。">
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
              </FormBlock>
            )}

            {section === 'matrix' && (
              <div className="py-4">
                <PolicyMatrix
                  agents={projectAgents}
                  snapshot={snapshot}
                  formatValue={formatValue}
                />
              </div>
            )}

            {section === 'readiness' && (
              <div className="py-4">
                <ReadinessSummary
                  project={project}
                  agents={projectAgents}
                  snapshot={snapshot}
                  formatValue={formatValue}
                  pendingChangeCount={totalChanges}
                  onOpenTarget={openReadinessTarget}
                />
              </div>
            )}
          </div>
        </div>

        <aside
          aria-label="待应用摘要"
          aria-busy={pendingStageCount > 0}
          className="flex w-72 shrink-0 flex-col border-l border-line bg-raised"
        >
          <div className="border-b border-line px-3 py-2.5">
            <h3 className="text-sm font-medium text-ink">
              待应用修改 · {totalChanges}
            </h3>
            <p className="mt-0.5 text-[9px] text-muted">
              应用后仅影响下一次 Run
            </p>
          </div>
          {draftsWithChanges.length === 0 ? (
            <div className="p-3">
              <p className="text-xs text-muted">暂无待应用变更</p>
              <p className="mt-1.5 text-[9px] text-muted">
                更改字段后会在这里生成摘要；「放弃全部变更」会恢复 applied
                值。工作区布局不进入此列表。
              </p>
            </div>
          ) : (
            <ul className="min-h-0 flex-1 overflow-auto">
              {draftsWithChanges.map((draft) => {
                const label = ownerLabel(draft.owner)
                return (
                  <li
                    key={ownerKey(draft.owner)}
                    className="border-b border-line px-3 py-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-[10px] font-semibold text-ink">
                        {label}：{draft.changes.length} 项变更
                      </strong>
                      <button
                        aria-label={`丢弃「${label}」的草稿`}
                        className="mini-button"
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
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {draft.changes.map((change) => (
                        <li
                          key={change.fieldPath}
                          className="text-[9px] text-muted"
                        >
                          {fieldDescriptor(change.fieldPath)?.label ??
                            change.fieldPath}
                          ：{formatValue(change.fieldPath, change.applied)} →{' '}
                          {formatValue(change.fieldPath, change.draft)}
                        </li>
                      ))}
                    </ul>
                  </li>
                )
              })}
            </ul>
          )}
          {pendingStageCount > 0 && (
            <p role="status" className="px-3 pb-2 text-xs text-muted">
              正在暂存 {pendingStageCount} 项修改…
            </p>
          )}
          {feedback && (
            <p
              role={feedback.kind === 'alert' ? 'alert' : 'status'}
              className={`px-3 pb-2 text-xs ${
                feedback.kind === 'alert' ? 'text-danger' : 'text-teal'
              }`}
            >
              {feedback.message}
            </p>
          )}
        </aside>
      </div>

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
// Frozen-baseline building blocks (#68)
// ---------------------------------------------------------------------------

/** Catalog entry of the frozen settings nav: icon chip + label + scope
 *  description. `aria-label` keeps the accessible name exactly the section
 *  label; the description stays visible context. */
function NavItem({
  label,
  icon,
  description,
  active,
  onClick
}: {
  label: string
  icon: string
  description: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={`grid w-full grid-cols-[27px_minmax(0,1fr)] items-center gap-2 rounded-lg border px-1.5 py-[5px] text-left ${
        active
          ? 'border-brand-border bg-paper shadow-lift'
          : 'border-transparent hover:bg-paper'
      }`}
      onClick={onClick}
    >
      <span
        aria-hidden="true"
        className="grid h-[27px] w-[27px] place-items-center rounded-[7px] bg-wash text-[11px] font-bold text-ink"
      >
        {icon}
      </span>
      <span className="min-w-0">
        <strong className="block truncate text-[10px] font-semibold text-ink">
          {label}
        </strong>
        <small className="block truncate text-[8px] text-muted">
          {description}
        </small>
      </span>
    </button>
  )
}

/** Muted scope pill of the frozen detail head. */
function DetailBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-wash px-2 py-1 text-[9px] text-muted">
      {children}
    </span>
  )
}

/** One form section of the frozen variant A, separated by a bottom hairline. */
function FormBlock({
  title,
  badge,
  note,
  children
}: {
  title?: string
  badge?: ReactNode
  note?: string
  children: ReactNode
}) {
  return (
    <div className="border-b border-line py-4 last:border-b-0">
      {(title || badge) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          {title && (
            <h3 className="text-xs font-semibold text-ink">{title}</h3>
          )}
          {badge}
        </div>
      )}
      {note && <p className="mb-2 text-[9px] text-muted">{note}</p>}
      {children}
    </div>
  )
}

/** Frozen `.readonly` control: an adapter-owned fact, never an input. */
function ReadonlyFieldRow({
  label,
  description,
  value,
  note
}: {
  label: string
  description: string
  value: string
  note: string
}) {
  return (
    <li className="grid grid-cols-[minmax(150px,0.42fr)_minmax(0,0.58fr)] items-start gap-x-5 gap-y-1 py-2">
      <div className="min-w-0">
        <strong className="text-[10px] font-semibold text-ink">{label}</strong>
        <p className="mt-1 max-w-[48ch] text-[9px] text-muted">
          {description}
        </p>
      </div>
      <div className="min-w-0">
        <div className="flex min-h-[34px] w-full max-w-[420px] items-center justify-between gap-2 rounded-lg border border-line bg-wash px-2.5 py-1">
          <strong className="text-[10px] font-semibold text-ink">
            {value}
          </strong>
          {note && (
            <small className="shrink-0 text-[8px] text-muted">{note}</small>
          )}
        </div>
      </div>
    </li>
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

  const controlClass =
    'h-[34px] w-full max-w-[420px] rounded-lg border border-line bg-paper px-2.5 text-xs text-ink'

  return (
    <li className="grid grid-cols-[minmax(150px,0.42fr)_minmax(0,0.58fr)] items-start gap-x-5 gap-y-1 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <strong className="text-[10px] font-semibold text-ink">
            {descriptor.label}
          </strong>
          <span className="chip shrink-0">
            {TIMING_LABEL[descriptor.timing]}
          </span>
        </div>
        <p className="mt-1 max-w-[48ch] text-[9px] text-muted">
          {FIELD_DESCRIPTION[fieldPath] ?? ''}
        </p>
      </div>
      <div className="min-w-0">
        {descriptor.kind === 'select' ? (
          <select
            aria-label={descriptor.label}
            className={controlClass}
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
            className={controlClass}
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
        <p className="mt-1 text-[9px] text-muted">
          当前：{formatValue(appliedValue)}（v{appliedVersion}）
          {draftChange && (
            <span className="ml-1.5 text-amber">
              待应用：{formatValue(draftChange.draft)}
            </span>
          )}
        </p>
        {error && <p className="mt-0.5 text-[9px] text-danger">{error}</p>}
      </div>
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

  // Card-style comparison of the frozen variant B (#68): real table semantics
  // stay (row/column headers are the accessible structure), while cells carry
  // the prototype's strong + small double line. Columns never truncate — the
  // wrapper scrolls horizontally instead.
  return (
    <div>
      <div className="card">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th
                  scope="col"
                  className="min-w-[190px] border-b border-r border-line bg-raised px-3 py-2.5 text-left align-top"
                >
                  <span className="block text-[10px] font-semibold text-ink">
                    有效配置
                  </span>
                  <span className="mt-0.5 block text-[8px] font-normal text-muted">
                    不是愿望策略
                  </span>
                </th>
                {agents.map((agent) => {
                  const readiness = snapshot.runReadiness.find(
                    (r) => r.agentInstanceId === agent.agentInstanceId
                  )
                  return (
                    <th
                      key={agent.agentInstanceId}
                      scope="col"
                      className="min-w-[160px] border-b border-r border-line bg-raised px-3 py-2.5 text-left align-top last:border-r-0"
                    >
                      <span className="block text-[10px] font-semibold text-ink">
                        {agent.name}
                      </span>
                      <span className="mt-0.5 block text-[8px] font-normal text-muted">
                        {providerLabel(agent.providerId)} ·{' '}
                        {RUNTIME_STATE_LABEL[agent.runtimeState]}
                      </span>
                      {/* No readiness entry ⇒ no chip: 已阻止 must stay an
                          adapter-stated fact, never a renderer default. */}
                      {readiness && (
                        <span
                          className={`chip mt-1.5 ${
                            readiness.status === 'ready'
                              ? 'chip-good'
                              : 'chip-warn'
                          }`}
                        >
                          {readiness.status === 'ready' ? '就绪' : '已阻止'}
                        </span>
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {MATRIX_FIELD_PATHS.map((fieldPath) => {
                const descriptor = fieldDescriptor(fieldPath)
                return (
                  <tr key={fieldPath} className="last:[&>td]:border-b-0 last:[&>th]:border-b-0">
                    <th
                      scope="row"
                      className="border-b border-r border-line bg-raised/60 px-3 py-2.5 text-left align-top"
                    >
                      <span className="block text-[10px] font-semibold text-ink">
                        {descriptor?.label ?? fieldPath}
                      </span>
                      <span className="mt-0.5 block text-[8px] font-normal text-muted">
                        {descriptor ? TIMING_LABEL[descriptor.timing] : ''}
                      </span>
                    </th>
                    {agents.map((agent) => {
                      const value = appliedFor(agent)?.values[fieldPath]
                      const entry = effectiveEntryFor(agent, fieldPath)
                      const blocked = entry?.status === 'blocked'
                      return (
                        <td
                          key={agent.agentInstanceId}
                          className="min-w-[160px] border-b border-r border-line px-3 py-2.5 align-top last:border-r-0"
                        >
                          <span className="block text-[10px] font-semibold text-ink">
                            {value === undefined ||
                            value === null ||
                            value === ''
                              ? '未设置'
                              : formatValue(fieldPath, value)}
                          </span>
                          <span
                            className={`mt-0.5 block text-[8px] ${
                              blocked ? 'text-amber' : 'text-muted'
                            }`}
                          >
                            {blocked
                              ? `已阻止：${entry.blockedReason ?? ''}`
                              : '可生效'}
                          </span>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="notice-bar mt-3">
        矩阵不取代完整 Settings 导航，也不提供批量复制密钥。
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Settings C — next-Run readiness: read-only adapter summary (#14)
// ---------------------------------------------------------------------------

/**
 * The frozen variant C review cards (#68). Every line is backed by an
 * existing adapter fact or an existing documented invariant; rows the
 * prototype shows but Phase 1 cannot back (Base drift, 项目默认网络) are
 * deliberately omitted rather than fabricated.
 */
function ReadinessSummary({
  project,
  agents,
  snapshot,
  formatValue,
  pendingChangeCount,
  onOpenTarget
}: {
  project: ProjectViewModel
  agents: AgentInstanceViewModel[]
  snapshot: WorkbenchViewModel
  formatValue: (fieldPath: string, value: unknown) => string
  pendingChangeCount: number
  onOpenTarget: (target: RunReadinessBlockerTarget) => void
}) {
  const targetLabel = (target: RunReadinessBlockerTarget): string =>
    target.kind === 'provider-health'
      ? '前往 Provider 健康'
      : `前往「${SECTIONS.find((s) => s.key === target.section)?.label ?? target.section}」设置`

  const projectOwner: ConfigurationOwner = {
    kind: 'project',
    projectId: project.projectId
  }
  const projectApplied = snapshot.appliedConfigurations.find(
    (c) => ownerKey(c.owner) === ownerKey(projectOwner)
  )
  const connectionId =
    projectApplied?.values['integrations.primaryConnectionId']
  const resourceScope = projectApplied?.values['integrations.resourceScope']

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <ReviewCard
          title="Provider readiness"
          note="只有 Doctor 通过的 Provider 才能创建实例；未通过时配置仍可暂存。"
        >
          {agents.map((agent) => (
            <ReviewLine
              key={agent.agentInstanceId}
              label={agent.name}
              sublabel={providerLabel(agent.providerId)}
            >
              <span
                className={`chip ${
                  agent.doctor === 'ready' ? 'chip-good' : 'chip-warn'
                }`}
              >
                {agent.doctor === 'ready' ? '通过' : '未通过'}
              </span>
            </ReviewLine>
          ))}
        </ReviewCard>

        <ReviewCard
          title="Workspace isolation"
          note="写入型 Agent 必须拥有独立 worktree。"
        >
          <ReviewLine label="独立 worktree">
            <span className="chip chip-good">Enforced</span>
          </ReviewLine>
          <ReviewLine label="共享可写 cwd">
            <span className="chip chip-warn">Never allowed</span>
          </ReviewLine>
        </ReviewCard>

        <ReviewCard
          title="Feishu trust boundary"
          note="浏览器身份、Connector 身份和 Project scope 严格分离。"
        >
          <ReviewLine label="主连接">
            <span className="text-[10px] text-ink">
              {connectionId
                ? formatValue('integrations.primaryConnectionId', connectionId)
                : '未连接（可选）'}
            </span>
          </ReviewLine>
          <ReviewLine label="授权资源">
            <span className="text-[10px] text-ink">
              {resourceScope ? String(resourceScope) : '未设置'}
            </span>
          </ReviewLine>
          <ReviewLine label="高风险确认">
            <span className="chip">永远二次确认</span>
          </ReviewLine>
        </ReviewCard>

        <ReviewCard
          title="Run policy"
          note="不支持的限制不会被伪装为已启用。"
        >
          <ReviewLine label="超时权限请求">
            <span className="chip">默认拒绝</span>
          </ReviewLine>
          <ReviewLine label="原始 CLI profile">
            <span className="chip chip-good">Not exposed</span>
          </ReviewLine>
        </ReviewCard>
      </div>

      {/* #14 per-instance readiness stays the deep-link entry point into the
          editing sections; the four cards above never replace it. */}
      <ReviewCard
        title="逐实例 Readiness"
        note="下一次 Run 的就绪状态与阻塞项；链接直达能清除阻塞的设置位置。"
      >
        <ul>
          {agents.map((agent) => {
            const readiness = snapshot.runReadiness.find(
              (r) => r.agentInstanceId === agent.agentInstanceId
            )
            if (!readiness) return null
            return (
              <li
                key={agent.agentInstanceId}
                className="border-t border-line/60 py-2 first:border-t-0"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold text-ink">
                    {agent.name}
                  </span>
                  <span className="text-[9px] text-muted">
                    {providerLabel(agent.providerId)}
                  </span>
                  <span
                    className={`chip ml-auto ${
                      readiness.status === 'ready' ? 'chip-good' : 'chip-warn'
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
                        className="flex items-center gap-2 text-[9px] text-muted"
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
      </ReviewCard>

      <ReviewCard
        title="配置生效边界"
        note="Panel、Tab、surface、筛选器和输入草稿自动保存；身份、权限、代理、环境、资源范围、并发与预算必须点击应用。"
      >
        <ReviewLine label="当前 Run">
          <span className="text-[10px] text-muted">
            保持 applied 配置，不静默重启
          </span>
        </ReviewLine>
        <ReviewLine label="下一次 Run">
          <span className="chip chip-brand">
            {pendingChangeCount > 0
              ? `${pendingChangeCount} 项草稿待应用`
              : '使用当前 applied 快照'}
          </span>
        </ReviewLine>
      </ReviewCard>

      <p className="text-[11px] text-muted">
        演示模式：Readiness 汇总基于 mock 场景；权限策略尚未接入
        PermissionBroker，Readiness 不代表真实强制能力。
      </p>
    </div>
  )
}

/** Frozen `.review-card`. */
function ReviewCard({
  title,
  note,
  children
}: {
  title: string
  note: string
  children: ReactNode
}) {
  return (
    <div className="card p-3">
      <h3 className="text-xs font-semibold text-ink">{title}</h3>
      <p className="mb-2 mt-0.5 text-[9px] text-muted">{note}</p>
      {children}
    </div>
  )
}

/** Frozen `.review-line`: label left, fact/chip right. */
function ReviewLine({
  label,
  sublabel,
  children
}: {
  label: string
  sublabel?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-[34px] items-center justify-between gap-3 border-t border-line/60 py-1 first:border-t-0">
      <span className="min-w-0">
        <strong className="block text-[10px] font-semibold text-ink">
          {label}
        </strong>
        {sublabel && (
          <small className="block text-[8px] text-muted">{sublabel}</small>
        )}
      </span>
      <span className="shrink-0 text-right">{children}</span>
    </div>
  )
}
