import { useRef, useState } from 'react'
import type {
  CommandRejectionReason,
  CommandResult,
  KnowledgeCacheViewModel,
  KnowledgeContainerViewModel,
  KnowledgeContainerState,
  KnowledgeResourceId,
  KnowledgeSecurityAction,
  ProjectViewModel
} from './workbench/contract'

const STATE_LABEL: Record<KnowledgeContainerState, string> = {
  online: '在线',
  offline: '离线',
  cached: '离线缓存',
  unavailable: '不可用',
  unconnected: '未连接'
}

const STATE_STYLE: Record<KnowledgeContainerState, string> = {
  online: 'text-emerald-300',
  offline: 'text-neutral-400',
  cached: 'text-amber-300',
  unavailable: 'text-red-300',
  unconnected: 'text-neutral-400'
}

type KnowledgeFailureReason = CommandRejectionReason | 'transport-error'

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
  const cache = (container as { cache?: KnowledgeCacheViewModel }).cache
  return Boolean(
    cache &&
      cache.readOnly === true &&
      typeof cache.version === 'string' &&
      cache.version.trim().length > 0 &&
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
          ? 'mt-2 rounded bg-amber-900/70 px-2 py-1 text-xs text-amber-100 hover:bg-amber-800'
          : 'mt-2 rounded bg-neutral-700 px-2 py-1 text-xs text-neutral-100 hover:bg-neutral-600'
      }
      onClick={() => onRecover(resourceId)}
    >
      恢复 Knowledge 连接
    </button>
  )
}

function KnowledgeStateFeedback({
  container,
  onOpenConnections,
  onRecoverConnection
}: {
  container: KnowledgeContainerViewModel
  onOpenConnections: () => void
  onRecoverConnection: (resourceId: KnowledgeResourceId) => void
}) {
  if (container.state === 'online') return null
  if (container.state === 'cached') {
    if (!hasValidKnowledgeCache(container)) {
      return (
        <div className="border-b border-red-900/70 bg-red-950/30 px-3 py-2 text-xs text-red-200">
          <p>缓存元数据不完整，不能作为有效离线缓存展示。</p>
          <p className="mt-1 text-red-300">
            Project 本地能力仍然可用。
          </p>
          <KnowledgeRecoveryButton
            resourceId={container.knowledgeResourceId}
            tone="neutral"
            onRecover={onRecoverConnection}
          />
        </div>
      )
    }
    return (
      <div className="border-b border-amber-900/70 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
        <p className="font-medium">离线缓存仅供只读，禁止编辑与写入。</p>
        <p className="mt-1 text-amber-300">
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
      <div className="border-b border-neutral-800 bg-neutral-900/60 px-3 py-3 text-sm text-neutral-300">
        <p>尚未配置 Knowledge 主连接。</p>
        <p className="mt-1 text-xs text-neutral-500">
          Project 仍然可用；Agent、Tasks、Activity 与本地 worktree 不受影响。
        </p>
        <button
          className="mt-3 rounded bg-neutral-700 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-600"
          onClick={onOpenConnections}
        >
          前往全局 Connections
        </button>
      </div>
    )
  }
  if (container.state === 'unavailable') {
    return (
      <div className="border-b border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-300">
        <p>Knowledge 容器当前不可用。</p>
        <p className="mt-1 text-neutral-500">
          Project 本地能力仍然可用。
        </p>
        <button
          className="mt-2 rounded bg-neutral-700 px-2 py-1 text-xs text-neutral-100 hover:bg-neutral-600"
          onClick={onOpenConnections}
        >
          检查全局 Connections
        </button>
      </div>
    )
  }

  return (
    <div className="border-b border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-300">
      <p>实时内容离线，且没有可用缓存。</p>
      <p className="mt-1 text-neutral-500">Project 本地能力仍然可用。</p>
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
  const commandAttemptRef = useRef(0)
  const [commandFailure, setCommandFailure] = useState<{
    reason: KnowledgeFailureReason
    message: string
    retry: () => Promise<CommandResult>
  } | null>(null)
  const runCommand = (operation: () => Promise<CommandResult>): void => {
    const attempt = ++commandAttemptRef.current
    setCommandFailure(null)
    void operation().then(
      (result) => {
        if (attempt !== commandAttemptRef.current) return
        if (result.ok) return
        setCommandFailure({
          reason: result.reason,
          message: result.message,
          retry: operation
        })
      },
      () => {
        if (attempt !== commandAttemptRef.current) return
        setCommandFailure({
          reason: 'transport-error',
          message: '命令传输失败，请重试',
          retry: operation
        })
      }
    )
  }
  const openConnections = (): void => runCommand(onOpenConnections)
  const recoverConnection = (resourceId: KnowledgeResourceId): void =>
    runCommand(() => onRecoverConnection(resourceId))
  const renderedState = container ? displayState(container) : 'unconnected'
  const binding = project.resourceBindings.find(
    (candidate) => candidate.bindingId === container?.resourceBindingId
  )

  return (
    <section role="region" aria-label="Knowledge" className="space-y-4">
      <header>
        <h2 className="text-lg font-medium text-neutral-100">Knowledge</h2>
        <p className="text-xs text-neutral-500">
          受控浏览器 chrome 与身份边界预览
        </p>
      </header>

      {missingTargetId ? (
        <div
          role="alert"
          className="rounded border border-red-900/70 bg-red-950/30 p-3 text-sm text-red-200"
        >
          无法打开 Knowledge 目标：{missingTargetId} 不存在或已解除绑定。
        </div>
      ) : container ? (
        <article
          aria-label={`当前知识资源：${container.label ?? '未命名资源'}`}
          className="overflow-hidden rounded border border-neutral-800 bg-neutral-950"
        >
          <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900 px-3 py-2">
            <div>
              <h3 className="text-sm font-medium text-neutral-100">
                {container.label ?? 'Knowledge 连接状态'}
              </h3>
              <span className="text-xs text-neutral-500">
                受控浏览器容器
              </span>
              {container.knowledgeResourceId && (
                <p className="text-[11px] text-neutral-600">
                  KnowledgeResourceId：{container.knowledgeResourceId}
                </p>
              )}
            </div>
            <span
              role="status"
              className={`text-xs ${STATE_STYLE[renderedState]}`}
            >
              {STATE_LABEL[renderedState]}
            </span>
          </div>
          <div
            role="toolbar"
            aria-label="Knowledge 浏览器 chrome"
            className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900/70 px-3 py-2"
          >
            <button
              type="button"
              aria-label="后退"
              disabled
              className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-600"
            >
              ←
            </button>
            <button
              type="button"
              aria-label="前进"
              disabled
              className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-600"
            >
              →
            </button>
            <button
              type="button"
              aria-label="刷新"
              disabled
              className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-600"
            >
              ↻
            </button>
            <input
              aria-label="当前受控位置"
              readOnly
              value={`${container.label ?? '未命名知识资源'}（契约化 Mock）`}
              className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-400 outline-none"
            />
          </div>

          <KnowledgeStateFeedback
            container={container}
            onOpenConnections={openConnections}
            onRecoverConnection={recoverConnection}
          />

          {commandFailure && (
            <div
              role="alert"
              aria-label="Knowledge 操作失败"
              className="border-b border-red-900/70 bg-red-950/30 px-3 py-2 text-xs text-red-200"
            >
              <p>
                操作失败（{FAILURE_REASON_LABEL[commandFailure.reason]}）：
                {commandFailure.message}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  className="rounded bg-red-900/70 px-2 py-1 hover:bg-red-800"
                  onClick={() => runCommand(commandFailure.retry)}
                >
                  重试上次操作
                </button>
                <button
                  className="rounded bg-neutral-700 px-2 py-1 text-neutral-100 hover:bg-neutral-600"
                  onClick={openConnections}
                >
                  检查全局 Connections
                </button>
              </div>
            </div>
          )}

          <div className="grid gap-3 p-3 text-sm lg:grid-cols-2">
            <div className="rounded bg-neutral-900 p-3 text-neutral-300">
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
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

            <div className="rounded border border-amber-900/70 bg-amber-950/30 p-3 text-xs text-amber-200">
              <p>人工浏览器身份与 Connector 执行身份严格隔离。</p>
              <p className="mt-1">
                两者不共享 Cookie、Token、浏览器 profile 或鉴权材料。
              </p>
            </div>
          </div>

          {container.knowledgeResourceId && (
            <div className="border-t border-neutral-800 p-3">
              <h4 className="text-sm font-medium text-neutral-200">
                浏览器安全边界演练
              </h4>
              <p className="mt-1 text-xs text-neutral-500">
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
                    className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
                    onClick={() =>
                      runCommand(() =>
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
                  className="mt-3 rounded bg-neutral-900 px-3 py-2 text-xs text-neutral-300"
                >
                  {container.securityFeedback.message}
                </p>
              )}
            </div>
          )}
        </article>
      ) : (
        <p className="text-sm text-neutral-500">暂无 Knowledge 容器状态</p>
      )}
    </section>
  )
}
