import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActivityEntry,
  AgentInstanceId,
  AgentInstanceViewModel,
  AgentProviderId,
  AttentionItemId,
  AttentionTarget,
  CommandResult,
  ConfirmationId,
  ConnectionId,
  GlobalSurface,
  HandoffId,
  HandoffImportState,
  HandoffValidationViewModel,
  HandoffViewModel,
  LayoutTargetEffect,
  PanelId,
  PermissionDecision,
  PermissionRequestViewModel,
  ProjectId,
  ProjectSurface,
  ProjectViewModel,
  TaskRef,
  WorkbenchCommand,
  WorkbenchCommandBody,
  WorkbenchPort,
  WorkbenchViewModel
} from './workbench/contract'
import { commandMayProduceLayoutTargetEffect, id } from './workbench/contract'
import { activityKindLabel } from './activity-display'
import { AgentsSurface } from './agents-surface'
import type { SendCommand } from './agents-surface'
import { AttentionDrawer } from './attention-drawer'
import { describeAttentionTarget } from './attention-display'
import { DispatchPicker } from './dispatch-picker'
import { SettingsSurface } from './settings-surface'
import { TasksSurface } from './tasks-surface'

// ---------------------------------------------------------------------------
// Hook — the renderer's sole connection to the port
// ---------------------------------------------------------------------------

function useWorkbench(port: WorkbenchPort) {
  const [snapshot, setSnapshot] = useState<WorkbenchViewModel | null>(null)
  const revisionRef = useRef<number>(-1)

  const applySnapshot = useCallback((snap: WorkbenchViewModel) => {
    if (snap.revision > revisionRef.current) {
      revisionRef.current = snap.revision
      setSnapshot(snap)
    }
  }, [])

  useEffect(() => {
    let active = true
    const unsubscribe = port.subscribe((event) => {
      if (event.kind === 'view-model-updated') {
        applySnapshot(event.snapshot)
      }
    })
    void port.getSnapshot().then((snap) => {
      if (active) applySnapshot(snap)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [port, applySnapshot])

  const sendCommand = useCallback(
    (
      body: WorkbenchCommandBody,
      expectedRevision?: number
    ): Promise<CommandResult> => {
      const command = {
        ...body,
        commandId: id(crypto.randomUUID(), 'CommandId'),
        // Discrete actions default to the latest known revision; gestures
        // based on an older render pass their baseline explicitly, so the
        // port can reject them as stale instead of letting them overwrite
        // state that arrived after the gesture started.
        expectedRevision: expectedRevision ?? revisionRef.current
      } as WorkbenchCommand
      const result = port.dispatch(command)
      void result.then((r) => {
        if (!r.ok && r.reason === 'stale-revision') {
          void port.getSnapshot().then(applySnapshot)
        }
      })
      return result
    },
    [port, applySnapshot]
  )

  const planDispatch = useCallback<WorkbenchPort['planDispatch']>(
    (request) => {
      const result = port.planDispatch(request)
      void result.then(
        (planned) => {
          if (!planned.ok && planned.reason === 'stale-revision') {
            void port.getSnapshot().then(applySnapshot, () => {})
          }
        },
        () => {}
      )
      return result
    },
    [port, applySnapshot]
  )

  const navigate = useCallback(
    (projectId: ProjectId, surface: ProjectSurface): Promise<CommandResult> =>
      sendCommand({ kind: 'navigate', projectId, surface }),
    [sendCommand]
  )

  const navigateGlobal = useCallback(
    (surface: GlobalSurface) =>
      sendCommand({ kind: 'navigate-global', surface }),
    [sendCommand]
  )

  const requestConnectionDeletion = useCallback(
    (connectionId: ConnectionId) => {
      setConfirmationError(null)
      confirmAttemptRef.current++ // invalidate any in-flight confirm
      return sendCommand({ kind: 'request-connection-deletion', connectionId })
    },
    [sendCommand]
  )

  const requestProviderRecovery = useCallback(
    (providerId: AgentProviderId) =>
      sendCommand({ kind: 'request-provider-recovery', providerId }),
    [sendCommand]
  )

  const [confirmationError, setConfirmationError] = useState<{
    id: ConfirmationId
    message: string
  } | null>(null)
  const confirmAttemptRef = useRef(0)

  const confirmDangerousAction = useCallback(
    (confirmationId: ConfirmationId) => {
      confirmAttemptRef.current++
      const attempt = confirmAttemptRef.current
      const result = sendCommand({
        kind: 'confirm-dangerous-action',
        confirmationId
      })
      void result.then((r) => {
        if (attempt !== confirmAttemptRef.current) return // stale attempt
        if (!r.ok && r.reason !== 'stale-revision') {
          setConfirmationError({ id: confirmationId, message: r.message })
        }
      })
      return result
    },
    [sendCommand]
  )

  const dismissConfirmation = useCallback(() => {
    setConfirmationError(null)
    confirmAttemptRef.current++ // invalidate any in-flight confirm
    return sendCommand({ kind: 'dismiss-confirmation' })
  }, [sendCommand])

  return {
    snapshot,
    navigate,
    planDispatch,
    sendCommand,
    navigateGlobal,
    requestConnectionDeletion,
    requestProviderRecovery,
    confirmDangerousAction,
    dismissConfirmation,
    confirmationError
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SURFACES: Array<{ surface: ProjectSurface; label: string }> = [
  { surface: 'overview', label: '概览' },
  { surface: 'agents', label: 'Agent' },
  { surface: 'tasks', label: '任务' },
  { surface: 'knowledge', label: '知识' },
  { surface: 'handoffs', label: '交接' },
  { surface: 'activity', label: '活动' },
  { surface: 'settings', label: '设置' }
]

const GLOBAL_ENTRIES: Array<{ surface: GlobalSurface; label: string }> = [
  { surface: 'connections', label: '连接' },
  { surface: 'provider-health', label: 'Provider 健康' },
  { surface: 'global-settings', label: '全局设置' }
]

const ROOT_LABEL: Record<string, string> = {
  available: '可用',
  unavailable: '不可用'
}

const GIT_LABEL: Record<string, string> = {
  ready: '已就绪',
  'not-ready': '未就绪'
}

const CONNECTION_STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  disconnected: '未连接',
  offline: '离线',
  error: '错误'
}

type RetainedRunTarget = Extract<AttentionTarget, { kind: 'run' }>

type RetainedTargetSettlement =
  | { kind: 'pending' }
  | { kind: 'rejected' }
  | { kind: 'accepted-effect'; effect: LayoutTargetEffect | undefined }
  | { kind: 'accepted-target'; target: RetainedRunTarget | null }

type RetainedTargetIntent = {
  token: number
  retainedEpoch: number
  retainedTarget: RetainedRunTarget | null
  settlement: RetainedTargetSettlement
}

function retainedTargetDecision(
  effect: LayoutTargetEffect,
  retainedAgentInstanceId: AgentInstanceId
): 'switch' | 'retain' | 'neutral' {
  if (effect.kind === 'selected-agent') {
    return effect.agentInstanceId === retainedAgentInstanceId
      ? 'retain'
      : 'switch'
  }
  if (effect.agentInstanceId === retainedAgentInstanceId) return 'switch'
  if ('selectedAgentInstanceId' in effect) {
    return effect.selectedAgentInstanceId === retainedAgentInstanceId
      ? 'retain'
      : 'switch'
  }
  return 'neutral'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProjectShell({ port }: { port: WorkbenchPort }) {
  const {
    snapshot,
    navigate,
    planDispatch,
    sendCommand,
    navigateGlobal,
    requestConnectionDeletion,
    requestProviderRecovery,
    confirmDangerousAction,
    dismissConfirmation,
    confirmationError
  } = useWorkbench(port)
  // The unified Dispatch Picker lives at shell level so all Project surfaces
  // open the same dispatcher instead of owning divergent implementations.
  const [showPicker, setShowPicker] = useState(false)
  // Task-linked dispatch context (#10): set when the picker opens from the
  // Tasks surface so its confirmation creates task-linked Dispatch/Result
  // records instead of a bare dispatch.
  const [pickerTask, setPickerTask] = useState<{
    ref: TaskRef
    title: string
  } | null>(null)
  // Global Attention Center (#9): one shell-level drawer over every surface.
  const [showAttention, setShowAttention] = useState(false)
  // Close-window notice: shows that background state is preserved (#12 AC3).
  const [showCloseNotice, setShowCloseNotice] = useState(false)
  // Undelivered deep-link targets stay retained for their placeholder page
  // until the user navigates somewhere else explicitly.
  const [retainedDeepLink, setRetainedDeepLink] =
    useState<AttentionTarget | null>(null)
  // Permanent permission policy is managed only in Settings; a request from
  // the Permission Center remounts Settings on its permissions section.
  const [permissionsNavNonce, setPermissionsNavNonce] = useState(0)
  // Deep-link failures are surfaced, never dropped silently (#9).
  const [deepLinkNotice, setDeepLinkNotice] = useState<string | null>(null)
  // Generation token for in-flight deep links: any newer intentional
  // navigation (or a newer deep link) supersedes an awaiting attempt, whose
  // continuation must then send no further commands and write no local
  // state (spec 566–568 — stale results are safely ignored).
  const deepLinkAttemptRef = useRef(0)
  // Delivered targets have their own epoch. A layout Result may arrive after
  // a newer deep link, so its cleanup is valid only for the target that was
  // current when that layout command was sent.
  const retainedDeepLinkEpochRef = useRef(0)
  // Layout Results may settle out of order. Keep every command that started
  // while a Run was retained until all newer commands have settled; rejected
  // or structural results are neutral, while the latest accepted target
  // effect supersedes every older one.
  const retainedTargetIntentCounterRef = useRef(0)
  const retainedTargetIntentsRef = useRef(
    new Map<number, RetainedTargetIntent>()
  )
  const activeDeepLinkIntentTokenRef = useRef<number | undefined>(undefined)
  const updateRetainedDeepLink = (target: AttentionTarget | null): void => {
    retainedDeepLinkEpochRef.current += 1
    retainedTargetIntentsRef.current.clear()
    activeDeepLinkIntentTokenRef.current = undefined
    setRetainedDeepLink(target)
  }
  const reconcileRetainedTargetIntents = (): void => {
    const intents = [...retainedTargetIntentsRef.current.values()]
      .filter(
        (intent) =>
          intent.retainedEpoch === retainedDeepLinkEpochRef.current
      )
      .sort((left, right) => right.token - left.token)
    for (const intent of intents) {
      if (intent.settlement.kind === 'pending') return
      if (intent.settlement.kind === 'rejected') {
        retainedTargetIntentsRef.current.delete(intent.token)
        continue
      }
      if (intent.settlement.kind === 'accepted-target') {
        retainedTargetIntentsRef.current.clear()
        updateRetainedDeepLink(intent.settlement.target)
        return
      }
      if (
        intent.settlement.effect === undefined ||
        intent.retainedTarget === null
      ) {
        retainedTargetIntentsRef.current.delete(intent.token)
        continue
      }
      const decision = retainedTargetDecision(
        intent.settlement.effect,
        intent.retainedTarget.agentInstanceId
      )
      if (decision === 'neutral') {
        retainedTargetIntentsRef.current.delete(intent.token)
        continue
      }
      // This is the newest accepted Agent-target consequence. It decides the
      // retained context and makes every older intent irrelevant.
      retainedTargetIntentsRef.current.clear()
      if (decision === 'switch') updateRetainedDeepLink(null)
      return
    }
  }
  const createRetainedTargetIntent = (
    retainedTarget: RetainedRunTarget | null
  ): number => {
    const token = ++retainedTargetIntentCounterRef.current
    retainedTargetIntentsRef.current.set(token, {
      token,
      retainedEpoch: retainedDeepLinkEpochRef.current,
      retainedTarget,
      settlement: { kind: 'pending' }
    })
    return token
  }
  const registerRetainedTargetIntent = (): number | undefined =>
    retainedDeepLink?.kind === 'run'
      ? createRetainedTargetIntent(retainedDeepLink)
      : undefined
  const registerAbsoluteRetainedTargetIntent = (): number =>
    createRetainedTargetIntent(
      retainedDeepLink?.kind === 'run' ? retainedDeepLink : null
    )
  const settleRetainedTargetIntent = (
    token: number | undefined,
    settlement: RetainedTargetSettlement
  ): void => {
    if (token === undefined) return
    const intent = retainedTargetIntentsRef.current.get(token)
    if (!intent) return
    intent.settlement = settlement
    reconcileRetainedTargetIntents()
  }
  const supersedeActiveDeepLinkIntent = (): number => {
    const attempt = ++deepLinkAttemptRef.current
    const activeToken = activeDeepLinkIntentTokenRef.current
    activeDeepLinkIntentTokenRef.current = undefined
    settleRetainedTargetIntent(activeToken, { kind: 'rejected' })
    return attempt
  }
  const beginDeepLinkIntent = (): {
    attempt: number
    retainedIntentToken: number | undefined
  } => {
    const previousToken = activeDeepLinkIntentTokenRef.current
    const attempt = ++deepLinkAttemptRef.current
    // Register the replacement before retiring the previous barrier so an
    // already-settled older target effect cannot commit in between them.
    const retainedIntentToken = registerRetainedTargetIntent()
    activeDeepLinkIntentTokenRef.current = retainedIntentToken
    settleRetainedTargetIntent(previousToken, { kind: 'rejected' })
    return { attempt, retainedIntentToken }
  }

  if (!snapshot) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 text-neutral-500">
        加载中…
      </div>
    )
  }

  const project =
    snapshot.projects.find((p) => p.projectId === snapshot.activeProjectId) ??
    snapshot.projects[0]

  const inGlobalView = snapshot.activeGlobalSurface !== undefined

  const projectAgents = project
    ? snapshot.agents.filter((a) => a.projectId === project.projectId)
    : []
  const connection = project
    ? snapshot.global.connections.find(
        (c) => c.connectionId === project.primaryConnectionId
      )
    : undefined
  const projectActivity = project
    ? snapshot.activity
        .filter((a) => a.projectId === project.projectId)
        .sort((a, b) => b.timestamp - a.timestamp)
    : []

  /**
   * Attention deep links (#9). Delivered targets navigate straight to their
   * work entry (overview / unique Agent Tab); undelivered details retain the
   * target and land on the explicit placeholder page of their surface.
   *
   * A command response may arrive before its view-model-updated event, so
   * the follow-up layout command binds the first command's acceptedRevision
   * instead of assuming the event has already landed. Both results are
   * checked — a rejection surfaces a notice instead of failing silently.
   */
  const openAgentWorkspace = async (
    targetProject: ProjectViewModel,
    agentInstanceId: AgentInstanceId,
    baseRevision: number
  ): Promise<CommandResult> => {
    const panels = Object.entries(targetProject.layout.panels) as Array<
      [PanelId, { tabs: AgentInstanceId[] }]
    >
    const holder = panels.find(([, panel]) =>
      panel.tabs.includes(agentInstanceId)
    )
    if (holder) {
      return sendCommand(
        {
          kind: 'change-layout',
          projectId: targetProject.projectId,
          operation: {
            kind: 'activate-tab',
            panelId: holder[0],
            agentInstanceId
          }
        },
        baseRevision
      )
    }
    const targetPanelId =
      targetProject.layout.focusedPanelId ??
      panels[0]?.[0] ??
      id('panel-auto', 'PanelId')
    return sendCommand(
      {
        kind: 'change-layout',
        projectId: targetProject.projectId,
        operation: { kind: 'open-tab', panelId: targetPanelId, agentInstanceId }
      },
      baseRevision
    )
  }

  const openAttentionTarget = async (
    target: AttentionTarget
  ): Promise<void> => {
    const { attempt, retainedIntentToken } = beginDeepLinkIntent()
    // A newer deep link is itself a pending target intent. It must block an
    // older accepted layout Result from clearing the retained Run after the
    // new target's Event has landed but before its Result returns.
    const abandonRetainedIntent = () => {
      if (activeDeepLinkIntentTokenRef.current === retainedIntentToken) {
        activeDeepLinkIntentTokenRef.current = undefined
      }
      settleRetainedTargetIntent(retainedIntentToken, { kind: 'rejected' })
    }
    const isCurrent = () => deepLinkAttemptRef.current === attempt
    setShowAttention(false)
    setDeepLinkNotice(null)
    const targetProject = snapshot.projects.find(
      (p) => p.projectId === target.projectId
    )
    if (!targetProject) {
      abandonRetainedIntent()
      return
    }
    const navResult = await navigate(target.projectId, deepLinkSurface(target))
    if (!isCurrent()) {
      abandonRetainedIntent()
      return // superseded by a newer navigation
    }
    if (!navResult.ok) {
      abandonRetainedIntent()
      setDeepLinkNotice(`无法打开目标：${navResult.message}`)
      return
    }
    if (target.kind === 'agent' || target.kind === 'run') {
      // Once the Agent layout command is issued, its authoritative target
      // effect must remain ordered even if another gesture cancels the rest
      // of this deep-link continuation. Register that phase before retiring
      // the navigation barrier so an older settled effect cannot commit in
      // between them.
      const layoutIntentToken = registerAbsoluteRetainedTargetIntent()
      if (activeDeepLinkIntentTokenRef.current === retainedIntentToken) {
        activeDeepLinkIntentTokenRef.current = undefined
      }
      settleRetainedTargetIntent(retainedIntentToken, { kind: 'rejected' })
      const layoutResult = await openAgentWorkspace(
        targetProject,
        target.agentInstanceId,
        navResult.acceptedRevision
      )
      settleRetainedTargetIntent(
        layoutIntentToken,
        layoutResult.ok
          ? {
              kind: 'accepted-target',
              target: target.kind === 'run' ? target : null
            }
          : { kind: 'rejected' }
      )
      if (!isCurrent()) {
        return // superseded while opening the workspace
      }
      if (!layoutResult.ok) {
        setDeepLinkNotice(
          `已到达 Agent 工作面，但未能打开目标 Tab：${layoutResult.message}`
        )
      } else {
        // The accepted issued-layout intent already committed this absolute
        // deep-link target through the ordering ledger.
        return
      }
    }
    // Run details are not delivered yet: the target stays retained on an
    // explicit notice next to the owning Agent workspace.
    updateRetainedDeepLink(
      target.kind === 'project' || target.kind === 'agent' ? null : target
    )
  }

  const answerPermission = (
    request: PermissionRequestViewModel,
    decision: PermissionDecision
  ): Promise<CommandResult> =>
    sendCommand({
      kind: 'answer-permission',
      projectId: request.projectId,
      agentInstanceId: request.agentInstanceId,
      runId: request.runId,
      requestId: request.requestId,
      decision
    })

  // Explicit navigation is an absolute retained-target consequence, just
  // like an issued deep-link layout command. Ordering it in the same ledger
  // prevents older layout Results from crossing a pending navigation, while
  // a rejected navigation remains neutral and preserves the current target.
  const sendExplicitNavigation = (
    navigateAway: () => Promise<CommandResult>,
    onAcceptedCurrent?: () => void
  ): Promise<CommandResult> => {
    const intentToken = registerAbsoluteRetainedTargetIntent()
    const attempt = supersedeActiveDeepLinkIntent()
    const result = navigateAway()
    void result.then((outcome) => {
      settleRetainedTargetIntent(
        intentToken,
        outcome.ok
          ? {
              kind: 'accepted-target',
              target: null
            }
          : { kind: 'rejected' }
      )
      if (outcome.ok && deepLinkAttemptRef.current === attempt) {
        setDeepLinkNotice(null)
        onAcceptedCurrent?.()
      }
    })
    return result
  }

  // Permanent policy is never created from a request; the Permission Center
  // only navigates into the Settings permissions section (UX-v0.2 §10).
  // Local state (drawer close, section remount) commits only after the
  // navigation is actually accepted — a rejection keeps the drawer context.
  const managePermanentPolicy = (
    projectId: ProjectId
  ): Promise<CommandResult> =>
    sendExplicitNavigation(
      () => navigate(projectId, 'settings'),
      () => {
        setShowAttention(false)
        setPermissionsNavNonce((nonce) => nonce + 1)
      }
    )

  const resolveAttention = (
    attentionItemId: AttentionItemId
  ): Promise<CommandResult> =>
    sendCommand({ kind: 'resolve-attention', attentionItemId })

  // Agent Directory, Tab, Panel and opened-on-create gestures supersede an
  // in-flight deep link, so each user-driven layout target bumps that token.
  // Delivered Run cleanup is ordered separately: the port's authoritative
  // target effects are settled by command intent order, not response order.
  // Rejections and structural effects are neutral. Deep-link-owned layout
  // commands use raw sendCommand above and never invalidate themselves.
  const sendLayoutCommand: SendCommand = (body, expectedRevision) => {
    const mayProduceTargetEffect = commandMayProduceLayoutTargetEffect(body)
    if (body.kind !== 'change-layout' && !mayProduceTargetEffect) {
      return sendCommand(body, expectedRevision)
    }
    const intentToken = mayProduceTargetEffect
      ? registerRetainedTargetIntent()
      : undefined
    supersedeActiveDeepLinkIntent()
    setDeepLinkNotice(null)
    const result = sendCommand(body, expectedRevision)
    void result.then((outcome) => {
      settleRetainedTargetIntent(
        intentToken,
        outcome.ok
          ? { kind: 'accepted-effect', effect: outcome.layoutTargetEffect }
          : { kind: 'rejected' }
      )
    })
    return result
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <header
        inert={showPicker ? true : undefined}
        className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 text-sm"
      >
        <div className="flex items-center gap-3">
          <span className="font-medium">Agent Squad HQ</span>
          <div className="flex items-center gap-1">
            {GLOBAL_ENTRIES.map(({ surface, label }) => {
              const isActive =
                inGlobalView && snapshot.activeGlobalSurface === surface
              return (
                <button
                  key={surface}
                  aria-current={isActive ? 'page' : undefined}
                  className={`rounded px-2 py-0.5 text-xs transition-colors ${
                    isActive
                      ? 'bg-neutral-700 text-neutral-100'
                      : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
                  }`}
                  onClick={() => {
                    void sendExplicitNavigation(() => navigateGlobal(surface))
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
          {inGlobalView && project && (
            <button
              className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-700"
              onClick={() => {
                void sendExplicitNavigation(() =>
                  navigate(project.projectId, project.currentSurface)
                )
              }}
            >
              ← 返回项目
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            aria-label="Global Attention"
            className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700"
            onClick={() => setShowAttention(true)}
          >
            关注 {snapshot.global.attentionCount}
          </button>
          {project && (
            <button
              className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700"
              onClick={() => {
                setPickerTask(null)
                setShowPicker(true)
              }}
            >
              派发给 Agent
            </button>
          )}
          {!inGlobalView && connection && (
            <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
              {connection.label}
            </span>
          )}
          <button
            className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-700"
            onClick={() => setShowCloseNotice(true)}
          >
            关闭窗口
          </button>
          <button
            className="rounded bg-red-900 px-2 py-0.5 text-xs text-red-300 hover:bg-red-800"
            onClick={() => {
              void sendCommand({ kind: 'request-quit-preview' })
            }}
          >
            退出
          </button>
        </div>
      </header>

      {inGlobalView ? (
        <main
          inert={showPicker ? true : undefined}
          className="min-h-0 flex-1 overflow-auto p-4"
        >
          {snapshot.activeGlobalSurface === 'connections' && (
            <ConnectionsSurface
              connections={snapshot.global.connections}
              onDelete={(connectionId) =>
                void requestConnectionDeletion(connectionId)
              }
            />
          )}
          {snapshot.activeGlobalSurface === 'provider-health' && (
            <ProviderHealthSurface
              providers={snapshot.global.providers}
              onRecovery={(providerId) =>
                void requestProviderRecovery(providerId)
              }
            />
          )}
          {snapshot.activeGlobalSurface === 'global-settings' && (
            <GlobalSettingsSurface />
          )}
        </main>
      ) : project ? (
        <div
          inert={showPicker ? true : undefined}
          className="flex min-h-0 flex-1"
        >
          <nav
            className="w-48 shrink-0 border-r border-neutral-800 p-2"
            aria-label="主导航"
          >
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-wide text-neutral-600">
                当前项目
              </div>
              <select
                aria-label="切换项目"
                className="mt-0.5 w-full rounded bg-neutral-900 px-1.5 py-1 text-sm text-neutral-200 outline-none"
                value={project.projectId}
                onChange={(e) => {
                  const targetId = id(e.target.value, 'ProjectId')
                  const target = snapshot.projects.find(
                    (p) => p.projectId === targetId
                  )
                  void sendExplicitNavigation(
                    () =>
                      navigate(
                        targetId,
                        target?.currentSurface ?? 'overview'
                      ),
                    () => setPermissionsNavNonce(0)
                  )
                }}
              >
                {snapshot.projects.map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-0.5">
              {SURFACES.map(({ surface, label }) => (
                <button
                  key={surface}
                  className={`block w-full rounded px-2 py-1 text-left text-sm transition-colors ${
                    project.currentSurface === surface
                      ? 'bg-neutral-800 text-neutral-100'
                      : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
                  }`}
                  onClick={() => {
                    // The permissions deep link is one-shot: manual surface
                    // navigation consumes it so later Settings visits open
                    // on the default section again.
                    void sendExplicitNavigation(
                      () => navigate(project.projectId, surface),
                      () => setPermissionsNavNonce(0)
                    )
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </nav>

          <main className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
            {deepLinkNotice && (
              <div
                role="alert"
                className="mb-3 rounded bg-red-950/60 px-3 py-1.5 text-xs text-red-300"
              >
                {deepLinkNotice}
              </div>
            )}
            {project.currentSurface === 'agents' &&
              retainedDeepLink?.kind === 'run' &&
              retainedDeepLink.projectId === project.projectId && (
                <div
                  role="status"
                  className="mb-3 rounded bg-neutral-900 px-3 py-1.5 text-xs text-neutral-400"
                >
                  已保留目标：{describeAttentionTarget(retainedDeepLink)}
                  （Run 详情尚未交付，已打开所属 Agent 工作区）
                </div>
              )}
            {project.currentSurface === 'overview' && (
              <OverviewSurface
                project={project}
                agentCount={projectAgents.length}
                connectionLabel={connection?.label}
                activity={projectActivity.slice(0, 5)}
                onDispatch={() => setShowPicker(true)}
              />
            )}
            {project.currentSurface === 'activity' && (
              <ActivitySurface activity={projectActivity} />
            )}
            {project.currentSurface === 'agents' && (
              <AgentsSurface
                key={project.projectId}
                project={project}
                snapshot={snapshot}
                planDispatch={planDispatch}
                sendCommand={sendLayoutCommand}
                onDispatch={() => setShowPicker(true)}
              />
            )}
            {project.currentSurface === 'settings' && (
              <SettingsSurface
                key={`${project.projectId}:${permissionsNavNonce}`}
                project={project}
                snapshot={snapshot}
                sendCommand={sendCommand}
                initialSection={
                  permissionsNavNonce > 0 ? 'permissions' : undefined
                }
              />
            )}
            {project.currentSurface === 'tasks' && (
              <TasksSurface
                key={project.projectId}
                project={project}
                snapshot={snapshot}
                sendCommand={sendCommand}
                highlightTaskRef={
                  retainedDeepLink &&
                  (retainedDeepLink.kind === 'project-task' ||
                    retainedDeepLink.kind === 'external-task') &&
                  retainedDeepLink.projectId === project.projectId
                    ? retainedDeepLink
                    : null
                }
                onDispatchTask={(taskRef, title) => {
                  setPickerTask({ ref: taskRef, title })
                  setShowPicker(true)
                }}
              />
            )}
            {project.currentSurface === 'handoffs' && (
              <HandoffsSurface
                snapshot={snapshot}
                project={project}
                sendCommand={sendCommand}
                focusHandoffId={
                  retainedDeepLink?.kind === 'handoff' &&
                  retainedDeepLink.projectId === project.projectId
                    ? retainedDeepLink.handoffId
                    : undefined
                }
              />
            )}
            {project.currentSurface !== 'overview' &&
              project.currentSurface !== 'activity' &&
              project.currentSurface !== 'agents' &&
              project.currentSurface !== 'settings' &&
              project.currentSurface !== 'tasks' &&
              project.currentSurface !== 'handoffs' && (
                <PlaceholderSurface
                  surface={project.currentSurface}
                  retainedTarget={
                    retainedDeepLink &&
                    deepLinkSurface(retainedDeepLink) === project.currentSurface
                      ? retainedDeepLink
                      : null
                  }
                />
              )}
          </main>
        </div>
      ) : (
        <div
          inert={showPicker ? true : undefined}
          className="flex min-h-0 flex-1 items-center justify-center bg-neutral-950 text-neutral-500"
        >
          没有可用的 Project
        </div>
      )}

      {showPicker && project && (
        <DispatchPicker
          project={project}
          snapshot={snapshot}
          planDispatch={planDispatch}
          sendCommand={sendCommand}
          taskContext={pickerTask}
          onClose={() => {
            setPickerTask(null)
            setShowPicker(false)
          }}
        />
      )}

      {showAttention && (
        <AttentionDrawer
          snapshot={snapshot}
          onClose={() => setShowAttention(false)}
          onOpenTarget={(target) => void openAttentionTarget(target)}
          onAnswerPermission={answerPermission}
          onManagePolicy={managePermanentPolicy}
          onResolve={resolveAttention}
        />
      )}

      {snapshot.pendingConfirmation && (
        <ConfirmationModal
          confirmation={snapshot.pendingConfirmation}
          error={
            confirmationError?.id ===
            snapshot.pendingConfirmation!.confirmationId
              ? confirmationError.message
              : null
          }
          onConfirm={() =>
            void confirmDangerousAction(
              snapshot.pendingConfirmation!.confirmationId
            )
          }
          onCancel={() => void dismissConfirmation()}
        />
      )}

      {showCloseNotice && (
        <CloseWindowNotice onClose={() => setShowCloseNotice(false)} />
      )}

      {snapshot.quitPreview && !snapshot.pendingConfirmation && (
        <QuitPreviewDialog
          preview={snapshot.quitPreview}
          onAction={(action) => {
            void sendCommand({ kind: 'execute-quit', action }).then(
              (result) => {
                if (!result.ok && result.reason === 'stale-revision') {
                  void sendCommand(
                    { kind: 'request-quit-preview' },
                    result.latestRevision
                  )
                }
              }
            )
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Project surfaces
// ---------------------------------------------------------------------------

function OverviewSurface({
  project,
  agentCount,
  connectionLabel,
  activity,
  onDispatch
}: {
  project: ProjectViewModel
  agentCount: number
  connectionLabel?: string
  activity: ActivityEntry[]
  onDispatch: () => void
}) {
  return (
    <section role="region" aria-label="项目概览" className="space-y-4">
      <h2 className="text-lg font-medium text-neutral-100">{project.name}</h2>

      <div className="flex gap-6 text-sm">
        <div>
          <span className="text-neutral-500">根目录</span>
          <span className="ml-1.5 text-neutral-200">
            {ROOT_LABEL[project.rootAvailability]}
          </span>
        </div>
        <div>
          <span className="text-neutral-500">Git</span>
          <span className="ml-1.5 text-neutral-200">
            {GIT_LABEL[project.repositoryReadiness]}
          </span>
        </div>
      </div>

      <div className="text-sm">
        <span className="text-neutral-500">连接</span>
        <span className="ml-1.5 text-neutral-200">
          {connectionLabel ?? '未连接'}
        </span>
      </div>

      <div className="flex gap-3">
        <StatCard value={agentCount} label="Agent" />
        <StatCard value={project.activeRunCount} label="活动运行" />
        <StatCard value={project.queuedRunCount} label="排队" />
        <StatCard value={project.attentionCount} label="关注" />
      </div>

      <div className="flex gap-2">
        <button
          className="rounded bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700"
          onClick={onDispatch}
        >
          派发给 Agent
        </button>
      </div>

      <div>
        <h3 className="mb-2 text-sm text-neutral-400">最近活动</h3>
        <ul className="space-y-1">
          {activity.map((entry) => (
            <li key={entry.activityId} className="text-xs text-neutral-400">
              {entry.summary}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function StatCard({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded bg-neutral-900 px-3 py-2">
      <span className="text-xl text-neutral-100">{value}</span>
      <span className="ml-1 text-xs text-neutral-500">{label}</span>
    </div>
  )
}

function ActivitySurface({ activity }: { activity: ActivityEntry[] }) {
  return (
    <section role="region" aria-label="活动" className="space-y-2">
      <h2 className="mb-3 text-lg text-neutral-200">活动</h2>
      {activity.length === 0 ? (
        <p className="text-sm text-neutral-500">暂无活动记录</p>
      ) : (
        <ul className="space-y-2">
          {activity.map((entry) => (
            <li
              key={entry.activityId}
              className="border-b border-neutral-800 pb-2 text-sm"
            >
              <div className="text-neutral-300">{entry.summary}</div>
              <div className="mt-0.5 text-xs text-neutral-600">
                {activityKindLabel(entry.kind)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function PlaceholderSurface({
  surface,
  retainedTarget
}: {
  surface: ProjectSurface
  retainedTarget?: AttentionTarget | null
}) {
  const label = SURFACES.find((s) => s.surface === surface)?.label ?? surface
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <p className="text-sm text-neutral-500">{label} 工作面尚未实现</p>
      {retainedTarget && (
        <p className="text-xs text-neutral-600">
          已保留目标：{describeAttentionTarget(retainedTarget)}
          （详情尚未交付）
        </p>
      )}
    </div>
  )
}

/** The surface an Attention deep link lands on (#9). */
function deepLinkSurface(target: AttentionTarget): ProjectSurface {
  switch (target.kind) {
    case 'project':
      return 'overview'
    case 'agent':
    case 'run':
      return 'agents'
    case 'project-task':
    case 'external-task':
      return 'tasks'
    case 'knowledge':
      return 'knowledge'
    case 'handoff':
      return 'handoffs'
  }
}

// ---------------------------------------------------------------------------
// Global surfaces
// ---------------------------------------------------------------------------

function ConnectionsSurface({
  connections,
  onDelete
}: {
  connections: WorkbenchViewModel['global']['connections']
  onDelete: (connectionId: ConnectionId) => void
}) {
  return (
    <section role="region" aria-label="全局连接" tabIndex={-1} className="space-y-3">
      <h2 className="text-lg font-medium text-neutral-100">连接</h2>
      {connections.length === 0 ? (
        <p className="text-sm text-neutral-500">暂无连接</p>
      ) : (
        <ul className="space-y-2">
          {connections.map((conn) => (
            <li
              key={conn.connectionId}
              className="flex items-center justify-between rounded bg-neutral-900 px-3 py-2"
            >
              <div className="flex items-center gap-3">
                <span className="text-sm text-neutral-200">{conn.label}</span>
                <span className="text-xs text-neutral-500">
                  {CONNECTION_STATUS_LABEL[conn.status] ?? conn.status}
                </span>
              </div>
              <button
                className="rounded bg-red-950 px-2 py-0.5 text-xs text-red-400 hover:bg-red-900"
                onClick={() => onDelete(conn.connectionId)}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ProviderHealthSurface({
  providers,
  onRecovery
}: {
  providers: WorkbenchViewModel['global']['providers']
  onRecovery: (providerId: AgentProviderId) => void
}) {
  return (
    <section role="region" aria-label="Provider 健康" className="space-y-3">
      <h2 className="text-lg font-medium text-neutral-100">Provider 健康</h2>
      <ul className="space-y-2">
        {providers.map((p) => (
          <li
            key={p.providerId}
            className="flex items-center justify-between rounded bg-neutral-900 px-3 py-2"
          >
            <span className="text-sm text-neutral-200">{p.displayName}</span>
            <div className="flex items-center gap-2">
              <span
                className={`text-xs ${
                  p.status === 'ready' ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {p.status === 'ready' ? '可用' : '已阻断'}
              </span>
              {p.status === 'blocked' && (
                <button
                  className="text-xs text-blue-400 hover:text-blue-300"
                  onClick={() => onRecovery(p.providerId)}
                >
                  恢复
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function GlobalSettingsSurface() {
  return (
    <section role="region" aria-label="全局设置" className="space-y-3">
      <h2 className="text-lg font-medium text-neutral-100">全局设置</h2>
      <p className="text-sm text-neutral-500">全局设置工作面尚未实现</p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Handoffs surface (#12 AC1)
// ---------------------------------------------------------------------------

const COMPLETENESS_LABEL: Record<'complete' | 'incomplete', string> = {
  complete: '完整',
  incomplete: '不完整'
}

const VALIDATION_LABEL: Record<HandoffValidationViewModel['status'], string> = {
  pass: '验证通过',
  fail: '验证失败',
  pending: '验证待完成'
}

const IMPORT_STATE_LABEL: Record<HandoffImportState, string> = {
  'not-imported': '未导入',
  'inspect-only': '已检查',
  'execute-confirmed': '已确认执行'
}

function HandoffsSurface({
  snapshot,
  project,
  sendCommand,
  focusHandoffId
}: {
  snapshot: WorkbenchViewModel
  project: ProjectViewModel
  sendCommand: (
    body: WorkbenchCommandBody,
    expectedRevision?: number
  ) => Promise<CommandResult>
  focusHandoffId?: HandoffId
}) {
  const handoffs = snapshot.handoffs.filter(
    (h) => h.projectId === project.projectId
  )
  const projectAgents = snapshot.agents.filter(
    (a) => a.projectId === project.projectId
  )
  const focusRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (focusHandoffId && focusRef.current) {
      focusRef.current.scrollIntoView?.({
        behavior: 'smooth',
        block: 'center'
      })
    }
  }, [focusHandoffId])

  if (handoffs.length === 0) {
    return (
      <section role="region" aria-label="交接" className="space-y-3">
        <h2 className="mb-3 text-lg text-neutral-200">交接</h2>
        <p className="text-sm text-neutral-500">暂无交接记录</p>
      </section>
    )
  }

  return (
    <section role="region" aria-label="交接" className="space-y-3">
      <h2 className="mb-3 text-lg text-neutral-200">交接</h2>
      <ul className="space-y-3">
        {handoffs.map((h) => {
          const isFocused = focusHandoffId === h.handoffId
          return (
            <li
              key={h.handoffId}
              ref={isFocused ? focusRef : undefined}
              className={`rounded-lg p-4 ${
                isFocused
                  ? 'bg-neutral-800 ring-2 ring-blue-600'
                  : 'bg-neutral-900'
              }`}
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${
                    h.completeness === 'complete'
                      ? 'bg-emerald-950 text-emerald-400'
                      : 'bg-amber-950 text-amber-400'
                  }`}
                >
                  {COMPLETENESS_LABEL[h.completeness]}
                </span>
                <span className="text-xs text-neutral-500">
                  {IMPORT_STATE_LABEL[h.importState]}
                </span>
                {h.provenance.origin === 'cross-project' && (
                  <span className="rounded bg-blue-950 px-1.5 py-0.5 text-xs text-blue-400">
                    跨项目（来自 {h.provenance.sourceProjectName}）
                  </span>
                )}
                {h.provenance.origin === 'quit-snapshot' && (
                  <span className="rounded bg-red-950 px-1.5 py-0.5 text-xs text-red-400">
                    退出快照
                  </span>
                )}
                {h.provenance.origin === 'imported' && (
                  <span className="rounded bg-purple-950 px-1.5 py-0.5 text-xs text-purple-400">
                    导入
                  </span>
                )}
                <span className="font-mono text-[10px] text-neutral-600">
                  {h.handoffId}
                </span>
                <span className="text-[10px] text-neutral-600">
                  {PROVENANCE_ORIGIN_LABEL[h.provenance.origin]}
                  {new Date(h.provenance.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="text-sm text-neutral-200">{h.goal}</p>
              <p className="mt-1 text-xs text-neutral-500">{h.summary}</p>
              <dl className="mt-2 space-y-1 text-xs text-neutral-400">
                <div>
                  <dt className="inline text-neutral-600">来源：</dt>
                  <dd className="inline">{h.source.agentName}</dd>
                  {h.target && (
                    <>
                      <dt className="ml-2 inline text-neutral-600">目标：</dt>
                      <dd className="inline">{h.target.agentName}</dd>
                    </>
                  )}
                </div>
                <div>
                  <dt className="inline text-neutral-600">基线：</dt>
                  <dd className="inline font-mono">{h.baseCommit}</dd>
                  <dt className="ml-3 text-neutral-600">验证：</dt>
                  <dd className="inline">
                    {VALIDATION_LABEL[h.validation.status]}
                    {h.validation.message ? `（${h.validation.message}）` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-neutral-600">改动：</dt>
                  <dd className="inline">{h.changeSummary}</dd>
                </div>
                {h.artifacts.length > 0 && (
                  <div>
                    <dt className="inline text-neutral-600">产物：</dt>
                    <dd className="inline">
                      {h.artifacts
                        .map(
                          (a) =>
                            `${a.path}${a.status === 'missing' ? '（缺失）' : ''}`
                        )
                        .join('、')}
                    </dd>
                  </div>
                )}
                {h.incompleteReason && (
                  <div className="text-amber-400">
                    <dt className="inline text-amber-600">不完整原因：</dt>
                    <dd className="inline">{h.incompleteReason}</dd>
                  </div>
                )}
                {h.recoveryActions.length > 0 && (
                  <div>
                    <dt className="inline text-neutral-600">恢复动作：</dt>
                    <dd className="inline">{h.recoveryActions.join('；')}</dd>
                  </div>
                )}
              </dl>
              {h.importState === 'not-imported' && (
                <HandoffImportActions
                  handoffId={h.handoffId}
                  agents={projectAgents}
                  onImport={(targetAgentInstanceId, mode) =>
                    void sendCommand({
                      kind: 'import-handoff',
                      projectId: project.projectId,
                      handoffId: h.handoffId,
                      targetAgentInstanceId,
                      mode
                    })
                  }
                />
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const PROVENANCE_ORIGIN_LABEL: Record<
  HandoffViewModel['provenance']['origin'],
  string
> = {
  local: '本地 · ',
  imported: '导入 · ',
  'cross-project': '跨项目 · ',
  'quit-snapshot': '退出快照 · '
}

function HandoffImportActions({
  handoffId,
  agents,
  onImport
}: {
  handoffId: HandoffId
  agents: AgentInstanceViewModel[]
  onImport: (
    targetAgentInstanceId: AgentInstanceId,
    mode: 'inspect-only' | 'request-execute'
  ) => void
}) {
  const [targetId, setTargetId] = useState<string>('')
  const available = agents.filter(
    (a) => a.runtimeState !== 'unavailable' && a.runtimeState !== 'archived'
  )
  return (
    <div className="mt-3 flex items-center gap-2 border-t border-neutral-800 pt-2">
      <select
        aria-label={`导入目标 Agent ${handoffId}`}
        className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200"
        value={targetId}
        onChange={(e) => setTargetId(e.target.value)}
      >
        <option value="">选择目标 Agent…</option>
        {available.map((a) => (
          <option key={a.agentInstanceId} value={a.agentInstanceId}>
            {a.name}
          </option>
        ))}
      </select>
      <button
        className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
        disabled={!targetId}
        onClick={() =>
          onImport(id(targetId, 'AgentInstanceId'), 'inspect-only')
        }
      >
        仅导入检查
      </button>
      <button
        className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
        disabled={!targetId}
        onClick={() =>
          onImport(id(targetId, 'AgentInstanceId'), 'request-execute')
        }
      >
        导入并执行
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Close-window notice (#12 AC3)
// ---------------------------------------------------------------------------

function CloseWindowNotice({ onClose }: { onClose: () => void }) {
  const noticeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    noticeRef.current?.focus()
  }, [])
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="关闭窗口"
        className="w-full max-w-sm space-y-3 rounded-lg bg-neutral-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-medium text-neutral-100">关闭窗口</h3>
        <p className="text-sm text-neutral-400">
          关闭窗口不会停止后台 Run、Terminal 或 Agent。后台工作将继续运行。
        </p>
        <div className="flex justify-end pt-2">
          <button
            ref={noticeRef}
            className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
            onClick={onClose}
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Quit preview dialog (#12 AC3/AC4)
// ---------------------------------------------------------------------------

function QuitPreviewDialog({
  preview,
  onAction
}: {
  preview: WorkbenchViewModel['quitPreview']
  onAction: (
    action:
      | 'wait-for-runs'
      | 'stop-runs'
      | 'request-final-handoff'
      | 'force-quit'
  ) => void
}) {
  const quitRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    quitRef.current?.focus()
  }, [])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // In both phases, Escape dismisses the quit dialog. The contract
        // has no dedicated "cancel-quit" action — `wait-for-runs` is the
        // canonical dismiss path (clears quitPreview, preserves state).
        onAction('wait-for-runs')
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onAction])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="退出 Agent Squad HQ"
        className="w-full max-w-lg space-y-4 rounded-lg bg-neutral-900 p-5"
      >
        <h3 className="text-base font-medium text-neutral-100">
          退出 Agent Squad HQ
        </h3>

        {preview!.phase === 'resolve-active-work' ? (
          <p className="text-sm text-neutral-400">
            请先等待或停止活动 Run 与 Terminal，再生成最终 Handoff。
          </p>
        ) : (
          <p className="text-sm text-neutral-400">
            活动执行已处理。请为 handoff-dirty Agent 生成最终 Handoff。
          </p>
        )}

        {preview!.activeRuns.length > 0 && (
          <div>
            <h4 className="mb-1 text-sm text-neutral-400">
              活动 Run（{preview!.activeRuns.length}）
            </h4>
            <ul className="space-y-1 text-xs text-neutral-500">
              {preview!.activeRuns.map((run) => (
                <li key={run.runId}>
                  {run.agentName}（{run.runtimeState}）
                </li>
              ))}
            </ul>
          </div>
        )}

        {preview!.activeTerminals.length > 0 && (
          <div>
            <h4 className="mb-1 text-sm text-neutral-400">
              活动 Terminal（{preview!.activeTerminals.length}）
            </h4>
            <ul className="space-y-1 text-xs text-neutral-500">
              {preview!.activeTerminals.map((term) => (
                <li key={term.agentInstanceId}>{term.agentName}</li>
              ))}
            </ul>
          </div>
        )}

        {preview!.handoffDirtyAgents.length > 0 && (
          <div>
            <h4 className="mb-1 text-sm text-neutral-400">
              需最终 Handoff 的 Agent（{preview!.handoffDirtyAgents.length}）
            </h4>
            <ul className="space-y-1 text-xs text-neutral-500">
              {preview!.handoffDirtyAgents.map((agent) => (
                <li key={agent.agentInstanceId}>
                  {agent.agentName}：{agent.changeSummary}
                </li>
              ))}
            </ul>
          </div>
        )}

        {preview!.activeRuns.length === 0 &&
          preview!.activeTerminals.length === 0 &&
          preview!.handoffDirtyAgents.length === 0 && (
            <p className="text-sm text-neutral-500">
              没有活动 Run、Terminal 或待交接状态，可以安全退出。
            </p>
          )}

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button
            ref={quitRef}
            className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
            onClick={() => onAction('wait-for-runs')}
          >
            {preview!.phase === 'resolve-active-work'
              ? '等待 Run 完成'
              : '取消退出'}
          </button>
          {preview!.phase === 'resolve-active-work' ? (
            <button
              className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
              onClick={() => onAction('stop-runs')}
            >
              停止 Run
            </button>
          ) : (
            <button
              className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
              onClick={() => onAction('request-final-handoff')}
            >
              生成最终 Handoff
            </button>
          )}
          <button
            className="rounded bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-600"
            onClick={() => onAction('force-quit')}
          >
            强制退出
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Confirmation modal — reusable high-risk action host
// ---------------------------------------------------------------------------

function ConfirmationModal({
  confirmation,
  error,
  onConfirm,
  onCancel
}: {
  confirmation: WorkbenchViewModel['pendingConfirmation']
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Save the currently focused element to restore when the modal closes.
    const opener = document.activeElement as HTMLElement | null
    confirmRef.current?.focus()
    return () => {
      if (opener && document.body.contains(opener)) {
        opener.focus()
      } else {
        // Opener was removed (e.g., connection row deleted) — fall back to
        // the first remaining button in the content area; if none remain
        // (all connections deleted), focus the section heading.
        const mainEl = document.querySelector('main')
        const btn = mainEl?.querySelector<HTMLButtonElement>(
          'button:not([disabled])'
        )
        if (btn) {
          btn.focus()
        } else {
          const section = mainEl?.querySelector('[aria-label="全局连接"]')
          if (section instanceof HTMLElement) section.focus()
        }
      }
    }
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={confirmation!.action}
        className="w-full max-w-md space-y-3 rounded-lg bg-neutral-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-medium text-neutral-100">
          {confirmation!.action}
        </h3>
        <dl className="space-y-1.5 text-sm">
          <div>
            <dt className="inline text-neutral-500">目标：</dt>
            <dd className="inline text-neutral-200">{confirmation!.target}</dd>
          </div>
          <div>
            <dt className="inline text-neutral-500">影响：</dt>
            <dd className="inline text-neutral-200">{confirmation!.impact}</dd>
          </div>
          <div>
            <dt className="inline text-neutral-500">不可跳过：</dt>
            <dd className="inline text-neutral-200">
              {confirmation!.nonBypassableReason}
            </dd>
          </div>
        </dl>
        {error && (
          <div className="rounded bg-red-950/60 px-3 py-1.5 text-xs text-red-300">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            ref={confirmRef}
            className="rounded bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-600"
            onClick={onConfirm}
          >
            确认
          </button>
        </div>
      </div>
    </div>
  )
}
