import { id } from './contract'
import type { AgentInstanceViewModel, WorkbenchViewModel } from './contract'

/**
 * Standard mock scenario: two active projects with multiple named agents,
 * connection summary and recent activity. Used by MockScenarioAdapter as the
 * initial ViewModel snapshot.
 *
 * The primary project ("销售数据分析") carries eight agent instances with
 * repeated providers, varied runtime states and recency timestamps so the
 * Agent Directory can exercise search, filter and sort (#3).
 */
export function createStandardScenario(): WorkbenchViewModel {
  const now = Date.now()

  const projectId = id('proj-sales', 'ProjectId')
  const researchId = id('proj-research', 'ProjectId')
  const connId = id('conn-feishu-primary', 'ConnectionId')
  const panelId = id('panel-main', 'PanelId')
  const panelId2 = id('panel-research', 'PanelId')

  const claudeCode = id('claude-code', 'AgentProviderId')
  const codex = id('codex', 'AgentProviderId')
  const kimiCode = id('kimi-code', 'AgentProviderId')

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
      queueDepth: 0,
      doctor: 'ready',
      lastActivityAt,
      ...extra
    }
  }

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
        activeRunCount: 1,
        queuedRunCount: 1,
        attentionCount: 2,
        primaryConnectionId: connId,
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
        attentionCount: 0,
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
    agents: [
      agent(ccData, 'cc_data', claudeCode, 'running', now - 60_000, {
        activeRunId: id('run-001', 'RunId')
      }),
      agent(ccSql, 'cc_sql', claudeCode, 'needs-input', now - 300_000),
      agent(ccEtl, 'cc_etl', claudeCode, 'failed', now - 1_800_000),
      agent(cxAnti, 'cx_anti', codex, 'ready', now - 120_000, {
        terminalState: 'active'
      }),
      agent(cxForecast, 'cx_forecast', codex, 'queued', now - 600_000, {
        queueDepth: 1
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
    ],
    queue: [
      {
        queueItemId: id('queue-001', 'QueueItemId'),
        projectId,
        agentInstanceId: cxForecast,
        position: 1,
        priority: 'normal'
      }
    ],
    permissionRequests: [],
    attentionItems: [
      {
        attentionItemId: id('att-001', 'AttentionItemId'),
        target: { kind: 'agent', projectId, agentInstanceId: ccSql },
        state: 'open',
        title: 'cc_sql 需要确认文件写入权限'
      },
      {
        attentionItemId: id('att-002', 'AttentionItemId'),
        target: { kind: 'project', projectId },
        state: 'open',
        title: 'Q2 销售流水文件缺少 6 月数据'
      }
    ],
    configurationDrafts: [],
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
        summary: 'cc_sql 完成了 SQL schema 更新'
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
      attentionCount: 2,
      concurrency: {
        perAgentLimit: 1,
        projectLimit: 3,
        globalLimit: 6,
        activeGlobal: 1,
        queuedGlobal: 1
      },
      connections: [
        {
          connectionId: connId,
          label: '飞书 · 销售团队',
          status: 'connected'
        }
      ],
      providers: [
        { providerId: claudeCode, status: 'ready' },
        { providerId: codex, status: 'ready' },
        { providerId: kimiCode, status: 'ready' },
        { providerId: id('gemini-cli', 'AgentProviderId'), status: 'blocked' }
      ]
    }
  }
}
