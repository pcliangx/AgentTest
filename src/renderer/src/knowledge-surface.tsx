import { useRef, useState } from 'react'
import type {
  CommandRejectionReason,
  CommandResult,
  KnowledgeContainerViewModel,
  KnowledgeContainerState,
  KnowledgeResourceId,
  KnowledgeSecurityAction,
  ProjectViewModel
} from './workbench/contract'
import { StatusChip, type StatusChipTone } from './status-chip'

const STATE_LABEL: Record<KnowledgeContainerState, string> = {
  online: '在线',
  offline: '离线',
  cached: '离线缓存',
  unavailable: '不可用',
  unconnected: '未连接'
}

/** #69: color + decorative icon + text, one StatusChip for every state. */
const STATE_CHIP: Record<
  KnowledgeContainerState,
  { tone: StatusChipTone; icon: string }
> = {
  online: { tone: 'good', icon: '●' },
  offline: { tone: 'neutral', icon: '◌' },
  cached: { tone: 'warn', icon: '⚠' },
  unavailable: { tone: 'danger', icon: '✕' },
  unconnected: { tone: 'neutral', icon: '○' }
}

type KnowledgeFailureReason = CommandRejectionReason | 'transport-error'

type KnowledgeOperationKind = 'recovery' | 'connections' | 'security'

type KnowledgeCommandFailure = {
  reason: KnowledgeFailureReason
  message: string
  retry: () => Promise<CommandResult>
}

const KNOWLEDGE_OPERATION_ORDER: KnowledgeOperationKind[] = [
  'recovery',
  'connections',
  'security'
]

const KNOWLEDGE_OPERATION_COPY: Record<
  KnowledgeOperationKind,
  { action: string; failure: string }
> = {
  recovery: { action: '恢复连接', failure: '恢复连接失败' },
  connections: {
    action: '全局 Connections 导航',
    failure: '全局 Connections 导航失败'
  },
  security: { action: '安全演练', failure: '安全演练失败' }
}

const FAILURE_REASON_LABEL: Record<KnowledgeFailureReason, string> = {
  'stale-revision': '状态已更新',
  'invalid-target': '目标不存在',
  'invariant-violation': '状态不一致',
  unavailable: '当前不可用',
  busy: '操作繁忙',
  'confirmation-required': '需要确认',
  'not-enforceable': '无法执行',
  'scenario-read-only': '场景只读',
  'transport-error': '通信失败'
}

const OPERATION_LABEL = {
  read: '读取',
  create: '创建',
  update: '更新'
} as const

function formatCachedAt(timestamp: number): string {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return '不可用'
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function hasValidKnowledgeCache(
  container: KnowledgeContainerViewModel
): boolean {
  if (container.state !== 'cached') return false
  // The port is a runtime boundary. Keep a defensive guard even though the
  // discriminated union rejects malformed cached projections at compile time.
  const cache: unknown = container.cache
  if (typeof cache !== 'object' || cache === null) return false
  return (
    'readOnly' in cache &&
    cache.readOnly === true &&
    'version' in cache &&
    typeof cache.version === 'string' &&
    cache.version.trim().length > 0 &&
    'cachedAt' in cache &&
    typeof cache.cachedAt === 'number' &&
    Number.isFinite(cache.cachedAt) &&
    Number.isFinite(new Date(cache.cachedAt).getTime())
  )
}

function displayState(
  container: KnowledgeContainerViewModel
): KnowledgeContainerState {
  return container.state === 'cached' && !hasValidKnowledgeCache(container)
    ? 'unavailable'
    : container.state
}

function KnowledgeRecoveryButton({
  resourceId,
  tone,
  onRecover
}: {
  resourceId?: KnowledgeResourceId
  tone: 'warning' | 'neutral'
  onRecover: (resourceId: KnowledgeResourceId) => void
}) {
  if (!resourceId) return null
  return (
    <button
      className={
        tone === 'warning'
          ? 'mt-2 mini-button text-amber'
          : 'mt-2 mini-button'
      }
      onClick={() => onRecover(resourceId)}
    >
      恢复 Knowledge 连接
    </button>
  )
}

function KnowledgeIndependenceNote({
  project,
  className = 'mt-1 text-muted'
}: {
  project: ProjectViewModel
  className?: string
}) {
  const localCapabilitiesAvailable =
    project.lifecycle === 'active' && project.rootAvailability === 'available'
  return (
    <p className={className}>
      Knowledge 连接状态不会自行改变 Project 生命周期、Root
      可用性，以及 Agent、Tasks、Activity 与 worktree 的各自状态。
      {localCapabilitiesAvailable && (
        <> 当前仍可使用 Agents、本地 Tasks、Handoffs 与 Activity。</>
      )}
    </p>
  )
}

function KnowledgeStateFeedback({
  project,
  container,
  onOpenConnections,
  onRecoverConnection
}: {
  project: ProjectViewModel
  container: KnowledgeContainerViewModel
  onOpenConnections: () => void
  onRecoverConnection: (resourceId: KnowledgeResourceId) => void
}) {
  if (container.state === 'online') return null
  if (container.state === 'cached') {
    if (!hasValidKnowledgeCache(container)) {
      return (
        <div className="border-b border-line bg-danger-soft px-3 py-2 text-xs text-danger">
          <p>缓存元数据不完整，不能作为有效离线缓存展示。</p>
          <KnowledgeIndependenceNote
            project={project}
            className="mt-1 text-danger"
          />
          <KnowledgeRecoveryButton
            resourceId={container.knowledgeResourceId}
            tone="neutral"
            onRecover={onRecoverConnection}
          />
        </div>
      )
    }
    return (
      <div className="border-b border-line bg-amber-soft px-3 py-2 text-xs text-amber">
        <p className="font-medium">离线缓存仅供只读，禁止编辑与写入。</p>
        <p className="mt-1 text-amber">
          缓存版本：{container.cache.version} · 缓存时间：
          {formatCachedAt(container.cache.cachedAt)}
        </p>
        <KnowledgeRecoveryButton
          resourceId={container.knowledgeResourceId}
          tone="warning"
          onRecover={onRecoverConnection}
        />
      </div>
    )
  }
  if (container.state === 'unconnected') {
    return (
      <div className="border-b border-line bg-raised px-3 py-3 text-sm text-ink">
        <p>尚未配置 Knowledge 主连接。</p>
        <KnowledgeIndependenceNote
          project={project}
          className="mt-1 text-xs text-muted"
        />
        <button
          className="btn btn-primary mt-3"
          onClick={onOpenConnections}
        >
          前往全局 Connections
        </button>
      </div>
    )
  }
  if (container.state === 'unavailable') {
    return (
      <div className="border-b border-line bg-raised px-3 py-2 text-xs text-ink">
        <p>Knowledge 容器当前不可用。</p>
        <KnowledgeIndependenceNote project={project} />
        <button
          className="mini-button mt-2"
          onClick={onOpenConnections}
        >
          检查全局 Connections
        </button>
      </div>
    )
  }

  return (
    <div className="border-b border-line bg-raised px-3 py-2 text-xs text-ink">
      <p>实时内容离线，且没有可用缓存。</p>
      <KnowledgeIndependenceNote project={project} />
      <KnowledgeRecoveryButton
        resourceId={container.knowledgeResourceId}
        tone="neutral"
        onRecover={onRecoverConnection}
      />
    </div>
  )
}

export function KnowledgeSurface({
  project,
  container,
  missingTargetId,
  onOpenConnections,
  onRecoverConnection,
  onPreviewSecurityEvent
}: {
  project: ProjectViewModel
  container?: KnowledgeContainerViewModel
  missingTargetId?: KnowledgeResourceId
  onOpenConnections: () => Promise<CommandResult>
  onRecoverConnection: (
    resourceId: KnowledgeResourceId
  ) => Promise<CommandResult>
  onPreviewSecurityEvent: (
    resourceId: KnowledgeResourceId,
    action: KnowledgeSecurityAction
  ) => Promise<CommandResult>
}) {
  const operationAttemptRef = useRef<Record<KnowledgeOperationKind, number>>({
    recovery: 0,
    connections: 0,
    security: 0
  })
  const [commandFailures, setCommandFailures] = useState<
    Partial<Record<KnowledgeOperationKind, KnowledgeCommandFailure>>
  >({})
  const runCommand = (
    operationKind: KnowledgeOperationKind,
    operation: () => Promise<CommandResult>
  ): void => {
    const attempt = ++operationAttemptRef.current[operationKind]
    setCommandFailures((current) => {
      if (!current[operationKind]) return current
      const next = { ...current }
      delete next[operationKind]
      return next
    })
    void operation().then(
      (result) => {
        if (attempt !== operationAttemptRef.current[operationKind]) return
        if (result.ok) return
        setCommandFailures((current) => ({
          ...current,
          [operationKind]: {
            reason: result.reason,
            message: result.message,
            retry: operation
          }
        }))
      },
      () => {
        if (attempt !== operationAttemptRef.current[operationKind]) return
        setCommandFailures((current) => ({
          ...current,
          [operationKind]: {
            reason: 'transport-error',
            message: '命令传输失败，请重试',
            retry: operation
          }
        }))
      }
    )
  }
  const openConnections = (): void =>
    runCommand('connections', onOpenConnections)
  const recoverConnection = (resourceId: KnowledgeResourceId): void =>
    runCommand('recovery', () => onRecoverConnection(resourceId))
  const renderedState = container ? displayState(container) : 'unconnected'
  const binding = project.resourceBindings.find(
    (candidate) => candidate.bindingId === container?.resourceBindingId
  )

  return (
    <section role="region" aria-label="Knowledge" className="space-y-4">
      <header>
        <h2 className="text-lg font-medium text-ink">Knowledge</h2>
        <p className="text-xs text-muted">
          受控浏览器 chrome 与身份边界预览
        </p>
      </header>

      {missingTargetId ? (
        <div
          role="alert"
          className="rounded-lg border border-danger bg-danger-soft p-3 text-sm text-danger"
        >
          无法打开 Knowledge 目标：{missingTargetId} 不存在或已解除绑定。
        </div>
      ) : container ? (
        <article
          aria-label={`当前知识资源：${container.label ?? '未命名资源'}`}
          className="overflow-hidden rounded-xl border border-line bg-paper shadow-card"
        >
          <div className="flex items-center justify-between border-b border-line bg-raised px-4 py-2.5">
            <div>
              <h3 className="text-sm font-medium text-ink">
                {container.label ?? 'Knowledge 连接状态'}
              </h3>
              <span className="text-xs text-muted">
                受控浏览器容器
              </span>
              {container.knowledgeResourceId && (
                <p className="text-[11px] text-muted">
                  KnowledgeResourceId：{container.knowledgeResourceId}
                </p>
              )}
            </div>
            <span role="status">
              <StatusChip
                tone={STATE_CHIP[renderedState].tone}
                icon={STATE_CHIP[renderedState].icon}
              >
                {STATE_LABEL[renderedState]}
              </StatusChip>
            </span>
          </div>
          <div
            role="toolbar"
            aria-label="Knowledge 浏览器 chrome"
            className="flex items-center gap-2 border-b border-line bg-raised px-3 py-2"
          >
            <button
              type="button"
              aria-label="后退"
              disabled
              className="rounded border border-line px-2 py-1 text-xs text-muted"
            >
              ←
            </button>
            <button
              type="button"
              aria-label="前进"
              disabled
              className="rounded border border-line px-2 py-1 text-xs text-muted"
            >
              →
            </button>
            <button
              type="button"
              aria-label="刷新"
              disabled
              className="rounded border border-line px-2 py-1 text-xs text-muted"
            >
              ↻
            </button>
            <input
              aria-label="当前受控位置"
              readOnly
              value={`${container.label ?? '未命名知识资源'}（契约化 Mock）`}
              className="min-w-0 flex-1 rounded border border-line bg-paper px-2 py-1 text-xs text-muted"
            />
          </div>

          <KnowledgeStateFeedback
            project={project}
            container={container}
            onOpenConnections={openConnections}
            onRecoverConnection={recoverConnection}
          />

          {KNOWLEDGE_OPERATION_ORDER.map((operationKind) => {
            const commandFailure = commandFailures[operationKind]
            if (!commandFailure) return null
            const operationCopy = KNOWLEDGE_OPERATION_COPY[operationKind]
            return (
              <div
                key={operationKind}
                role="alert"
                aria-label={`Knowledge ${operationCopy.failure}`}
                className="border-b border-line bg-danger-soft px-3 py-2 text-xs text-danger"
              >
                <p>
                  {operationCopy.action}失败（
                  {FAILURE_REASON_LABEL[commandFailure.reason]}）：
                  {commandFailure.message}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    className="mini-button mini-button-danger"
                    onClick={() =>
                      runCommand(operationKind, commandFailure.retry)
                    }
                  >
                    重试{operationCopy.action}
                  </button>
                  <button
                    className="mini-button"
                    onClick={openConnections}
                  >
                    检查全局 Connections
                  </button>
                </div>
              </div>
            )
          })}

          <div className="grid gap-3 p-3 text-sm lg:grid-cols-2">
            <div className="rounded-lg border border-line bg-paper p-3 text-ink">
              <h4 className="section-label mb-2">
                身份与连接
              </h4>
              <div className="space-y-1">
                <p>
                  人工浏览器身份：
                  {container.humanBrowserIdentity ?? '未登录'}
                </p>
                <p>
                  Connector 执行身份：
                  {container.connectorIdentity ?? '未连接'}
                </p>
                <p>ConnectionId：{container.connectionId ?? '无'}</p>
                <p>
                  Project Resource Binding：{binding?.label ?? '未绑定'}
                </p>
                {binding && (
                  <>
                    <p>ResourceBindingId：{binding.bindingId}</p>
                    <p>
                      窄化操作范围：
                      {binding.allowedOperations
                        .map((operation) => OPERATION_LABEL[operation])
                        .join('、')}
                    </p>
                  </>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-line bg-amber-soft p-3 text-xs text-amber">
              <p>人工浏览器身份与 Connector 执行身份严格隔离。</p>
              <p className="mt-1">
                两者不共享 Cookie、Token、浏览器 profile 或鉴权材料。
              </p>
            </div>
          </div>

          {container.knowledgeResourceId && (
            <div className="border-t border-line p-3">
              <h4 className="text-sm font-medium text-ink">
                浏览器安全边界演练
              </h4>
              <p className="mt-1 text-xs text-muted">
                Phase 1 安全演练不创建 BrowserView、partition，不发起真实导航或网络请求。
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(
                  [
                    ['untrusted-link', '模拟不受信任链接'],
                    ['download', '模拟下载'],
                    ['popup', '模拟弹窗'],
                    ['permission-request', '模拟浏览器权限请求']
                  ] as const
                ).map(([action, label]) => (
                  <button
                    key={action}
                    className="mini-button"
                    onClick={() =>
                      runCommand('security', () =>
                        onPreviewSecurityEvent(
                          container.knowledgeResourceId!,
                          action
                        )
                      )
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              {container.securityFeedback && (
                <p
                  role="status"
                  aria-label="浏览器安全反馈"
                  className="mt-3 rounded-lg bg-raised px-3 py-2 text-xs text-ink"
                >
                  {container.securityFeedback.message}
                </p>
              )}
            </div>
          )}
        </article>
      ) : (
        <p className="text-sm text-muted">暂无 Knowledge 容器状态</p>
      )}
    </section>
  )
}
