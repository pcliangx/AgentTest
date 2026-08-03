import { describe, expect, it } from 'vitest'
import { createRunLifecycleScenario } from './standard-scenario'

describe('run lifecycle mock scenario (#38)', () => {
  it('exposes finishing, interrupted and completed-result facts directly', () => {
    const scenario = createRunLifecycleScenario()
    const finishing = scenario.agents.find((agent) => agent.name === 'cc_data')!
    const interrupted = scenario.agents.find(
      (agent) => agent.name === 'cc_etl'
    )!
    const completed = scenario.agents.find(
      (agent) => agent.name === 'cx_review'
    )!

    expect(finishing).toMatchObject({
      runtimeState: 'finishing',
      activeRunId: 'run-001'
    })
    expect(interrupted).toMatchObject({
      runtimeState: 'interrupted'
    })
    expect(interrupted.activeRunId).toBeUndefined()
    expect(completed).toMatchObject({
      runtimeState: 'ready'
    })
    expect(completed.activeRunId).toBeUndefined()
    expect(scenario.queue).toEqual([])
    expect(scenario.projects.map((project) => project.queuedRunCount)).toEqual([
      0,
      0
    ])
    expect(scenario.global.concurrency.queuedGlobal).toBe(0)
    expect(
      scenario.activity.find(
        (entry) => entry.activityId === 'act-lifecycle-interrupted'
      )
    ).toMatchObject({
      agentInstanceId: interrupted.agentInstanceId,
      kind: 'run-interrupted',
      summary: 'cc_etl 的 Run 已中断'
    })
    expect(
      scenario.activity.find(
        (entry) => entry.activityId === 'act-lifecycle-completed'
      )
    ).toMatchObject({
      agentInstanceId: completed.agentInstanceId,
      kind: 'run-completed',
      summary: 'cx_review 已完成客户流失复核'
    })
  })

  it('returns isolated snapshots for repeatable tests', () => {
    const first = createRunLifecycleScenario()
    const second = createRunLifecycleScenario()
    expect(second).toEqual(first)

    first.agents.find((agent) => agent.name === 'cc_data')!.runtimeState =
      'failed'

    expect(
      second.agents.find((agent) => agent.name === 'cc_data')?.runtimeState
    ).toBe('finishing')
  })
})
