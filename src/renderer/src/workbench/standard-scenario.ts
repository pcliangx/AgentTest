import { id } from './contract'
import type { WorkbenchViewModel } from './contract'

/**
 * Standard mock scenario: two active projects with multiple named agents,
 * connection summary and recent activity. Used by MockScenarioAdapter as the
 * initial ViewModel snapshot.
 */
export function createStandardScenario(): WorkbenchViewModel {
  const projectId = id('proj-sales', 'ProjectId')
  const researchId = id('proj-research', 'ProjectId')
  const connId = id('conn-feishu-primary', 'ConnectionId')
  const panelId = id('panel-main', 'PanelId')
  const panelId2 = id('panel-research', 'PanelId')

  const ccData = id('inst-cc-data', 'AgentInstanceId')
  const ccSql = id('inst-cc-sql', 'AgentInstanceId')
  const cxAnti = id('inst-cx-anti', 'AgentInstanceId')
  const kimiViz = id('inst-kimi-viz', 'AgentInstanceId')
  const ccReport = id('inst-cc-report', 'AgentInstanceId')
  const cxSurvey = id('inst-cx-survey', 'AgentInstanceId')

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
        queuedRunCount: 0,
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
      {
        agentInstanceId: ccData,
        projectId,
        name: 'cc_data',
        providerId: id('claude-code', 'AgentProviderId'),
        runtimeState: 'running',
        terminalState: 'closed',
        activeRunId: id('run-001', 'RunId'),
        queueDepth: 0,
        doctor: 'ready'
      },
      {
        agentInstanceId: ccSql,
        projectId,
        name: 'cc_sql',
        providerId: id('claude-code', 'AgentProviderId'),
        runtimeState: 'ready',
        terminalState: 'closed',
        queueDepth: 0,
        doctor: 'ready'
      },
      {
        agentInstanceId: cxAnti,
        projectId,
        name: 'cx_anti',
        providerId: id('codex', 'AgentProviderId'),
        runtimeState: 'ready',
        terminalState: 'closed',
        queueDepth: 0,
        doctor: 'ready'
      },
      {
        agentInstanceId: kimiViz,
        projectId,
        name: 'kimi_visual',
        providerId: id('kimi-code', 'AgentProviderId'),
        runtimeState: 'ready',
        terminalState: 'closed',
        queueDepth: 0,
        doctor: 'ready'
      },
      {
        agentInstanceId: ccReport,
        projectId: researchId,
        name: 'cc_report',
        providerId: id('claude-code', 'AgentProviderId'),
        runtimeState: 'ready',
        terminalState: 'closed',
        queueDepth: 0,
        doctor: 'ready'
      },
      {
        agentInstanceId: cxSurvey,
        projectId: researchId,
        name: 'cx_survey',
        providerId: id('codex', 'AgentProviderId'),
        runtimeState: 'ready',
        terminalState: 'closed',
        queueDepth: 0,
        doctor: 'ready'
      }
    ],
    queue: [],
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
        timestamp: Date.now() - 60_000,
        kind: 'run-started',
        summary: 'cc_data 开始清洗 Q2 销售流水'
      },
      {
        activityId: id('act-002', 'ActivityId'),
        projectId,
        agentInstanceId: ccSql,
        timestamp: Date.now() - 300_000,
        kind: 'run-completed',
        summary: 'cc_sql 完成了 SQL schema 更新'
      },
      {
        activityId: id('act-003', 'ActivityId'),
        projectId,
        timestamp: Date.now() - 600_000,
        kind: 'configuration-applied',
        summary: 'cc_data 的模型配置已更新'
      },
      {
        activityId: id('act-004', 'ActivityId'),
        projectId: researchId,
        agentInstanceId: ccReport,
        timestamp: Date.now() - 120_000,
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
        queuedGlobal: 0
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
      providers: [
        {
          providerId: id('claude-code', 'AgentProviderId'),
          displayName: 'Claude Code',
          status: 'ready'
        },
        {
          providerId: id('codex', 'AgentProviderId'),
          displayName: 'Codex',
          status: 'ready'
        },
        {
          providerId: id('kimi-code', 'AgentProviderId'),
          displayName: 'Kimi Code',
          status: 'blocked'
        }
      ]
    }
  }
}
