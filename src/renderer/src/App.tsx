import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'
import { createSmokeScenario } from './workbench/standard-scenario'
import { UI_SMOKE_SCENARIO } from '../../shared/ui-smoke-scenario'

/**
 * Phase 1 entry point.
 *
 * The renderer is driven entirely by WorkbenchPort. In Phase 1 this is an
 * in-memory MockScenarioAdapter; future phases will swap in a real
 * main/preload adapter that satisfies the same contract.
 */
const scenario = new URLSearchParams(window.location.search).get('scenario')
// The smoke scenario freezes the UI clock; the adapter must observe the
// same time source so permission deadlines and audit timestamps stay
// deterministic instead of mixing in the process wall clock (#9).
const adapter =
  scenario === UI_SMOKE_SCENARIO.id
    ? new MockScenarioAdapter(
        createSmokeScenario(UI_SMOKE_SCENARIO.clock),
        { now: () => UI_SMOKE_SCENARIO.clock }
      )
    : new MockScenarioAdapter()

if (scenario === UI_SMOKE_SCENARIO.id) {
  console.info(
    `Agent Squad HQ renderer scenario: ${UI_SMOKE_SCENARIO.id}@${UI_SMOKE_SCENARIO.clock}`
  )
  // Expose the adapter so Playwright specs can trigger edge-case commands
  // (e.g. stale-revision rejection) that are impossible to reach through
  // normal UI gestures alone.
  Object.assign(window, { __smokeAdapter: adapter })
}

export default function App() {
  return <ProjectShell port={adapter} />
}
