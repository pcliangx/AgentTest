import { ProjectShell } from './project-shell'
import { MockScenarioAdapter } from './workbench/mock-scenario-adapter'

/**
 * Phase 1 entry point.
 *
 * The renderer is driven entirely by WorkbenchPort. In Phase 1 this is an
 * in-memory MockScenarioAdapter; future phases will swap in a real
 * main/preload adapter that satisfies the same contract.
 */
const adapter = new MockScenarioAdapter()

export default function App() {
  return <ProjectShell port={adapter} />
}
