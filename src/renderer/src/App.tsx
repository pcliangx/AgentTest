import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'
import { createStandardScenario } from './workbench/standard-scenario'
import { UI_SMOKE_SCENARIO } from '../../shared/ui-smoke-scenario'

/**
 * Phase 1 entry point.
 *
 * The renderer is driven entirely by WorkbenchPort. In Phase 1 this is an
 * in-memory MockScenarioAdapter; future phases will swap in a real
 * main/preload adapter that satisfies the same contract.
 */
const scenario = new URLSearchParams(window.location.search).get('scenario')
const adapter =
  scenario === UI_SMOKE_SCENARIO.id
    ? new MockScenarioAdapter(
        createStandardScenario(UI_SMOKE_SCENARIO.clock)
      )
    : new MockScenarioAdapter()

if (scenario === UI_SMOKE_SCENARIO.id) {
  console.info(
    `Agent Squad HQ renderer scenario: ${UI_SMOKE_SCENARIO.id}@${UI_SMOKE_SCENARIO.clock}`
  )
}

export default function App() {
  return <ProjectShell port={adapter} />
}
