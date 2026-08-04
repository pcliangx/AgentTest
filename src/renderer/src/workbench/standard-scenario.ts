import { id } from './contract'
import type {
  AgentInstanceViewModel,
  AgentProviderId,
  AppliedConfigurationViewModel,
  ProjectId,
  WorkbenchViewModel
} from './contract'

const RUN_LIFECYCLE_SCENARIO_NOW = 1_700_000_000_000

/**
 * Standard mock scenario: two active projects with multiple named agents,
 * connection summary and recent activity. Used by MockScenarioAdapter as the
 * initial ViewModel snapshot.
 *
 * The primary project ("销售数据分析") carries eight agent instances with
 * repeated providers, varied runtime states and recency timestamps so the
 * Agent Directory can exercise search, filter and sort (#3).
 */
export function createStandardScenario(
  now: number = Date.now()
): WorkbenchViewModel {
  const projectId = id('proj-sales', 'ProjectId')
  const researchId = id('proj-research', 'ProjectId')
  const connId = id('conn-feishu-primary', 'ConnectionId')
  const panelId = id('panel-main', 'PanelId')
  const panelId2 = id('panel-research', 'PanelId')

  const claudeCode = id('claude-code', 'AgentProviderId')
  const codex = id('codex', 'AgentProviderId')
  const kimiCode = id('kimi-code', 'AgentProviderId')
  const providers: WorkbenchViewModel['global']['providers'] = [
    {
      providerId: claudeCode,
      displayName: 'Claude Code',
      status: 'ready',
      models: [{ modelId: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' }]
    },
    {
      providerId: codex,
      displayName: 'Codex',
      status: 'ready',
      models: [{ modelId: 'gpt-5-codex', displayName: 'GPT-5 Codex' }]
    },
    {
      providerId: kimiCode,
      displayName: 'Kimi Code',
      status: 'ready',
      models: [{ modelId: 'kimi-k2', displayName: 'Kimi K2' }]
    },
    {
      providerId: id('gemini-cli', 'AgentProviderId'),
      displayName: 'Gemini CLI',
      status: 'blocked',
      models: []
    }
  ]

  const ccData = id('inst-cc-data', 'AgentInstanceId')
  const ccSql = id('inst-cc-sql', 'AgentInstanceId')
  const ccEtl = id('inst-cc-etl', 'AgentInstanceId')
  const cxAnti = id('inst-cx-anti', 'AgentInstanceId')
  const cxForecast = id('inst-cx-forecast', 'AgentInstanceId')
  const cxReview = id('inst-cx-review', 'AgentInstanceId')
  const kimiViz = id('inst-kimi-viz', 'AgentInstanceId')
  const kimiDocs = id('inst-kimi-docs', 'AgentInstanceId')
  const ccReport = id('inst-cc-report', 'AgentInstanceId')
  const cxSurvey = id('inst-cx-survey', 'AgentInstanceId')

  function agent(
    agentInstanceId: AgentInstanceViewModel['agentInstanceId'],
    name: string,
    providerId: AgentInstanceViewModel['providerId'],
    runtimeState: AgentInstanceViewModel['runtimeState'],
    lastActivityAt: number,
    extra: Partial<AgentInstanceViewModel> = {}
  ): AgentInstanceViewModel {
    return {
      agentInstanceId,
      projectId,
      name,
      providerId,
      runtimeState,
      terminalState: 'closed',
      worktreeMode: 'isolated',
      queueDepth: 0,
      doctor: 'ready',
      lastActivityAt,
      ...extra
    }
  }

  /**
   * Applied configuration truth for the Settings A editor (#13). Every
   * configurable owner (each project + each instance) has an entry with the
   * full field set; drafts in `configurationDrafts` reference these paths.
   * `identity.name` mirrors the instance's visible name; run-configuration
   * fields (model/proxy/env/concurrency/budget/permissions/scope) only take
   * effect on the next Run.
   */
  const defaultModelFor = (providerId: AgentProviderId): string =>
    providers.find((provider) => provider.providerId === providerId)?.models[0]
      ?.modelId ?? ''

  function projectConfig(
    ownerProjectId: ProjectId,
    name: string,
    primaryConnectionId: string | null,
    appliedVersion: number
  ): AppliedConfigurationViewModel {
    return {
      owner: { kind: 'project', projectId: ownerProjectId },
      appliedVersion,
      values: {
        'general.name': name,
        'general.landingSurface': 'overview',
        'defaults.providerId': claudeCode,
        'defaults.model': defaultModelFor(claudeCode),
        'defaults.openMode': 'current-panel',
        'defaults.worktreeMode': 'isolated',
        'integrations.primaryConnectionId': primaryConnectionId,
        'integrations.resourceScope':
          ownerProjectId === projectId ? '销售团队任务清单、销售知识库' : '',
        'permissions.defaultPolicy': 'ask-each-time'
      }
    }
  }

  function agentConfig(
    a: AgentInstanceViewModel,
    appliedVersion: number
  ): AppliedConfigurationViewModel {
    return {
      owner: { kind: 'agent', agentInstanceId: a.agentInstanceId },
      appliedVersion,
      values: {
        'identity.name': a.name,
        'model.id': defaultModelFor(a.providerId),
        'proxy.http': '',
        'env.custom': '',
        'concurrency.priority': 'normal',
        'budget.maxTokens': 200000
      }
    }
  }

  const agents: AgentInstanceViewModel[] = [
    agent(ccData, 'cc_data', claudeCode, 'permission-requested', now - 60_000, {
      activeRunId: id('run-001', 'RunId'),
      // The active Run keeps its launch-time configuration snapshot (#13):
      // applying newer configuration never rewrites this version.
      activeRunConfigVersion: 3
    }),
    agent(ccSql, 'cc_sql', claudeCode, 'needs-input', now - 300_000, {
      activeRunId: id('run-sql-001', 'RunId')
    }),
    agent(ccEtl, 'cc_etl', claudeCode, 'failed', now - 1_800_000),
    agent(cxAnti, 'cx_anti', codex, 'ready', now - 120_000, {
      terminalState: 'active'
    }),
    agent(cxForecast, 'cx_forecast', codex, 'queued', now - 600_000, {
      queueDepth: 2
    }),
    agent(cxReview, 'cx_review', codex, 'ready', now - 30_000),
    agent(kimiViz, 'kimi_visual', kimiCode, 'ready', now - 240_000),
    agent(kimiDocs, 'kimi_docs', kimiCode, 'unavailable', now - 3_600_000),
    {
      ...agent(ccReport, 'cc_report', claudeCode, 'ready', now - 120_000),
      projectId: researchId
    },
    {
      ...agent(cxSurvey, 'cx_survey', codex, 'ready', now - 900_000),
      projectId: researchId
    }
  ]

  return {
    schemaVersion: 1,
    revision: 0,
    activeProjectId: projectId,
    projects: [
      {
        projectId,
        name: '销售数据分析',
        lifecycle: 'active',
        rootAvailability: 'available',
        repositoryReadiness: 'ready',
        activity: 'active',
        activeRunCount: 2,
        queuedRunCount: 2,
        attentionCount: 9,
        primaryConnectionId: connId,
        resourceBindings: [
          {
            bindingId: id('binding-sales-tasks', 'ResourceBindingId'),
            connectionId: connId,
            resourceType: 'task-list',
            label: '销售团队任务清单',
            allowedOperations: ['read', 'create', 'update']
          },
          {
            bindingId: id('binding-sales-wiki', 'ResourceBindingId'),
            connectionId: connId,
            resourceType: 'knowledge-space',
            label: '销售知识库',
            allowedOperations: ['read', 'update']
          }
        ],
        currentSurface: 'overview',
        layout: {
          root: { kind: 'panel', panelId },
          panels: {
            [panelId]: {
              tabs: [ccData],
              activeTabId: ccData
            }
          },
          focusedPanelId: panelId
        }
      },
      {
        projectId: researchId,
        name: '用户研究',
        lifecycle: 'active',
        rootAvailability: 'available',
        repositoryReadiness: 'ready',
        activity: 'idle',
        activeRunCount: 0,
        queuedRunCount: 0,
        attentionCount: 2,
        // No primary connection and no resource bindings — exercises the
        // "unbound" preview path (#6).
        resourceBindings: [],
        currentSurface: 'overview',
        layout: {
          root: { kind: 'panel', panelId: panelId2 },
          panels: {
            [panelId2]: {
              tabs: [ccReport],
              activeTabId: ccReport
            }
          },
          focusedPanelId: panelId2
        }
      }
    ],
    agents,
    queue: [
      {
        queueItemId: id('queue-001', 'QueueItemId'),
        projectId,
        agentInstanceId: cxForecast,
        position: 1,
        priority: 'normal'
      },
      {
        queueItemId: id('queue-002', 'QueueItemId'),
        projectId,
        agentInstanceId: cxForecast,
        position: 2,
        priority: 'low'
      }
    ],
    permissionRequests: [
      {
        // Actionable request holding cc_data's active Run (#9): the Run stays
        // in `permission-requested` until an explicit deny / allow-once /
        // allow-current-run decision.
        requestId: id('perm-001', 'PermissionRequestId'),
        projectId,
        agentInstanceId: ccData,
        runId: id('run-001', 'RunId'),
        action: '写入文件',
        scope: 'worktree 内 src/data/**',
        reason: '清洗 Q2 销售流水需要写入中间结果',
        expiresAt: now + 300_000,
        decisions: ['deny', 'allow-once', 'allow-current-run']
      },
      {
        // Already expired: timeout is simulated as denial, so this request
        // can no longer be allowed (#9).
        requestId: id('perm-002', 'PermissionRequestId'),
        projectId,
        agentInstanceId: ccSql,
        runId: id('run-sql-001', 'RunId'),
        action: '读取外部 API',
        scope: 'https://api.example.com',
        reason: '同步 6 月数据需要访问外部数据源',
        expiresAt: now - 1_000,
        decisions: ['deny', 'allow-once', 'allow-current-run']
      }
    ],
    attentionItems: [
      {
        attentionItemId: id('att-001', 'AttentionItemId'),
        kind: 'permission-requested',
        permissionRequestId: id('perm-001', 'PermissionRequestId'),
        target: {
          kind: 'run',
          projectId,
          agentInstanceId: ccData,
          runId: id('run-001', 'RunId')
        },
        state: 'open',
        title: 'cc_data 请求写入文件权限'
      },
      {
        attentionItemId: id('att-002', 'AttentionItemId'),
        kind: 'needs-input',
        target: { kind: 'agent', projectId, agentInstanceId: ccSql },
        state: 'open',
        title: 'cc_sql 等待输入：确认 6 月数据口径'
      },
      {
        attentionItemId: id('att-003', 'AttentionItemId'),
        kind: 'failed',
        target: { kind: 'agent', projectId, agentInstanceId: ccEtl },
        state: 'open',
        title: 'cc_etl 的 Run 失败：连接超时'
      },
      {
        attentionItemId: id('att-004', 'AttentionItemId'),
        kind: 'interrupted',
        target: {
          kind: 'run',
          projectId,
          agentInstanceId: ccEtl,
          runId: id('run-etl-001', 'RunId')
        },
        state: 'open',
        title: 'cc_etl 的上一次 Run 被中断'
      },
      {
        attentionItemId: id('att-005', 'AttentionItemId'),
        kind: 'completed',
        target: { kind: 'agent', projectId, agentInstanceId: cxReview },
        state: 'open',
        title: 'cx_review 已完成客户流失复核'
      },
      {
        attentionItemId: id('att-006', 'AttentionItemId'),
        kind: 'connection-conflict',
        target: {
          kind: 'external-task',
          projectId,
          externalTaskId: id('ext-task-001', 'ExternalTaskId')
        },
        state: 'open',
        title: '飞书任务「Q2 销售目标」存在版本冲突'
      },
      {
        attentionItemId: id('att-007', 'AttentionItemId'),
        kind: 'provider-unavailable',
        target: { kind: 'agent', projectId, agentInstanceId: kimiDocs },
        state: 'open',
        title: 'kimi_docs 不可用：Provider 连接失败'
      },
      {
        attentionItemId: id('att-008', 'AttentionItemId'),
        kind: 'completed',
        target: {
          kind: 'project-task',
          projectId,
          projectTaskId: id('ptask-001', 'ProjectTaskId')
        },
        state: 'open',
        title: '本地任务「月度报表」已完成'
      },
      {
        attentionItemId: id('att-009', 'AttentionItemId'),
        kind: 'connection-conflict',
        target: {
          kind: 'knowledge',
          projectId,
          knowledgeResourceId: id('know-001', 'KnowledgeResourceId')
        },
        state: 'open',
        title: '销售知识库有未同步的修改'
      },
      {
        attentionItemId: id('att-010', 'AttentionItemId'),
        kind: 'failed',
        target: {
          kind: 'handoff',
          projectId: researchId,
          handoffId: id('handoff-001', 'HandoffId')
        },
        state: 'open',
        title: '交接包不完整：缺少验证结果'
      },
      {
        attentionItemId: id('att-011', 'AttentionItemId'),
        kind: 'completed',
        target: { kind: 'project', projectId: researchId },
        state: 'open',
        title: '用户研究：后台 Project 已完成全部 Run'
      }
    ],
    configurationDrafts: [],
    appliedConfigurations: [
      projectConfig(projectId, '销售数据分析', connId, 2),
      projectConfig(researchId, '用户研究', null, 1),
      ...agents.map((a) =>
        agentConfig(a, a.agentInstanceId === ccData ? 3 : 1)
      )
    ],
    changes: [
      {
        agentInstanceId: ccData,
        baseCommit: 'a1b2c3d',
        drift: 'none',
        files: [
          {
            path: 'src/clean.ts',
            status: 'modified',
            additions: 24,
            deletions: 8
          },
          {
            path: 'src/types.ts',
            status: 'added',
            additions: 15,
            deletions: 0
          }
        ],
        validation: { status: 'pass' }
      },
      {
        agentInstanceId: ccSql,
        baseCommit: 'e4f5g6h',
        drift: 'behind',
        files: [
          {
            path: 'schema/migration.sql',
            status: 'modified',
            additions: 3,
            deletions: 1
          }
        ],
        validation: { status: 'pass' }
      },
      {
        agentInstanceId: cxAnti,
        baseCommit: 'i7j8k9l',
        drift: 'none',
        files: [
          {
            path: 'detect.py',
            status: 'modified',
            additions: 10,
            deletions: 5
          }
        ],
        validation: {
          status: 'fail',
          message: '类型检查失败：第 42 行有未定义变量'
        }
      }
    ],
    handoffs: [
      {
        handoffId: id('handoff-complete-001', 'HandoffId'),
        projectId,
        source: {
          agentInstanceId: ccData,
          agentName: 'cc_data'
        },
        target: {
          agentInstanceId: ccSql,
          agentName: 'cc_sql'
        },
        provenance: {
          origin: 'local',
          createdAt: now - 900_000
        },
        goal: '将清洗后的 Q2 销售流水交给 cc_sql 进行 schema 对齐',
        summary:
          'cc_data 完成了 Q2 销售流水的清洗，生成了类型定义和中间结果文件',
        baseCommit: 'a1b2c3d',
        changeSummary: '2 个文件变更：新增类型定义、修改清洗逻辑',
        artifacts: [
          { path: 'src/types.ts', status: 'included' },
          { path: 'src/clean.ts', status: 'included' }
        ],
        validation: { status: 'pass' },
        completeness: 'complete',
        recoveryActions: [],
        importState: 'not-imported'
      },
      {
        // Referenced by attention item att-010 in the research project.
        handoffId: id('handoff-001', 'HandoffId'),
        projectId: researchId,
        source: {
          agentInstanceId: ccReport,
          agentName: 'cc_report'
        },
        target: {
          agentInstanceId: cxSurvey,
          agentName: 'cx_survey'
        },
        provenance: {
          origin: 'local',
          createdAt: now - 700_000
        },
        goal: '将用户访谈摘要交给 cx_survey 设计问卷',
        summary: 'cc_report 完成了用户访谈摘要，但验证结果缺失',
        baseCommit: 'e4f5g6h',
        changeSummary: '1 个文件变更：用户访谈摘要草稿',
        artifacts: [{ path: 'docs/interview-summary.md', status: 'included' }],
        validation: {
          status: 'pending',
          message: '验证结果尚未生成'
        },
        completeness: 'incomplete',
        incompleteReason: '缺少验证结果：handoff 生成时 cc_report 的 Run 被中断',
        recoveryActions: [
          '重新对 cc_report 发起验证 Run',
          '手动检查 interview-summary.md 完整性后标记为 complete'
        ],
        importState: 'not-imported'
      },
      {
        // Cross-project handoff from sales to research — exercises the
        // inspect-only / execute-confirmed import flow (#12 AC2).
        handoffId: id('handoff-cross-002', 'HandoffId'),
        projectId: researchId,
        source: {
          agentInstanceId: cxReview,
          agentName: 'cx_review'
        },
        target: {
          agentInstanceId: ccReport,
          agentName: 'cc_report'
        },
        provenance: {
          origin: 'cross-project',
          createdAt: now - 500_000,
          sourceProjectName: '销售数据分析'
        },
        goal: '将客户流失复核结论导入用户研究 Project',
        summary:
          'cx_review 完成了客户流失异常值处理策略的复核，结论可用于用户研究',
        baseCommit: 'i7j8k9l',
        changeSummary: '1 个文件变更：流失复核策略文档',
        artifacts: [
          { path: 'docs/churn-review.md', status: 'included' },
          { path: 'docs/churn-data.csv', status: 'missing' }
        ],
        validation: { status: 'pass' },
        completeness: 'complete',
        recoveryActions: [],
        importState: 'not-imported'
      }
    ],
    activity: [
      {
        activityId: id('act-001', 'ActivityId'),
        projectId,
        agentInstanceId: ccData,
        timestamp: now - 60_000,
        kind: 'run-started',
        summary: 'cc_data 开始清洗 Q2 销售流水'
      },
      {
        activityId: id('act-002', 'ActivityId'),
        projectId,
        agentInstanceId: ccSql,
        timestamp: now - 300_000,
        kind: 'run-completed',
        summary: 'cc_sql 完成了 SQL schema 更新，已通知 @@cc_etl 同步'
      },
      {
        activityId: id('act-003', 'ActivityId'),
        projectId,
        timestamp: now - 600_000,
        kind: 'configuration-applied',
        summary: 'cc_data 的模型配置已更新'
      },
      {
        activityId: id('act-004', 'ActivityId'),
        projectId: researchId,
        agentInstanceId: ccReport,
        timestamp: now - 120_000,
        kind: 'run-completed',
        summary: 'cc_report 完成了用户访谈摘要'
      }
    ],
    global: {
      attentionCount: 11,
      concurrency: {
        perAgentLimit: 1,
        projectLimit: 3,
        globalLimit: 6,
        activeGlobal: 2,
        queuedGlobal: 2
      },
      connections: [
        {
          connectionId: connId,
          label: '飞书 · 销售团队',
          status: 'connected'
        },
        {
          connectionId: id('conn-feishu-product', 'ConnectionId'),
          label: '飞书 · 产品团队',
          status: 'disconnected'
        },
        {
          connectionId: id('conn-github', 'ConnectionId'),
          label: 'GitHub',
          status: 'error'
        }
      ],
      providers
    }
  }
}

/**
 * Deterministic lifecycle variant for reviewing states that should not be
 * conflated: an active Run finishing, a previous Run interrupted, and a
 * completed result retained in Activity after its Agent returned to ready.
 * It only builds ViewModel data and never starts a process or external I/O.
 */
export function createRunLifecycleScenario(): WorkbenchViewModel {
  const scenario = createStandardScenario(RUN_LIFECYCLE_SCENARIO_NOW)
  const finishing = scenario.agents.find((agent) => agent.name === 'cc_data')
  const interrupted = scenario.agents.find((agent) => agent.name === 'cc_etl')
  const completed = scenario.agents.find(
    (agent) => agent.name === 'cx_review'
  )
  const previouslyQueued = scenario.agents.find(
    (agent) => agent.name === 'cx_forecast'
  )
  if (!finishing || !interrupted || !completed || !previouslyQueued) {
    throw new Error('standard scenario lifecycle agents are missing')
  }

  finishing.runtimeState = 'finishing'
  interrupted.runtimeState = 'interrupted'
  delete interrupted.activeRunId
  delete interrupted.activeRunConfigVersion
  completed.runtimeState = 'ready'
  delete completed.activeRunId
  delete completed.activeRunConfigVersion
  // Remove unrelated queue pressure so the variant isolates lifecycle action
  // differences: finishing work queues, interrupted/ready work may start.
  scenario.queue = []
  previouslyQueued.runtimeState = 'ready'
  previouslyQueued.queueDepth = 0
  for (const project of scenario.projects) project.queuedRunCount = 0
  scenario.global.concurrency.queuedGlobal = 0

  const latestTimestamp = Math.max(
    0,
    ...scenario.activity.map((entry) => entry.timestamp)
  )
  const interruptedAt = latestTimestamp + 1
  const completedAt = latestTimestamp + 2
  interrupted.lastActivityAt = interruptedAt
  completed.lastActivityAt = completedAt
  scenario.activity = [
    {
      activityId: id('act-lifecycle-completed', 'ActivityId'),
      projectId: completed.projectId,
      agentInstanceId: completed.agentInstanceId,
      timestamp: completedAt,
      kind: 'run-completed',
      summary: 'cx_review 已完成客户流失复核'
    },
    {
      activityId: id('act-lifecycle-interrupted', 'ActivityId'),
      projectId: interrupted.projectId,
      agentInstanceId: interrupted.agentInstanceId,
      timestamp: interruptedAt,
      kind: 'run-interrupted',
      summary: 'cc_etl 的 Run 已中断'
    },
    ...scenario.activity
  ]
  return scenario
}
