import { isAbsolute } from 'node:path'
import type { ApplicationEnvironment } from './app-identity'
import {
  UI_SMOKE_SCENARIO,
  type UiSmokeScenario
} from '../shared/ui-smoke-scenario'

export type UiSmokeMode =
  | { readonly enabled: false }
  | {
      readonly enabled: true
      readonly userDataPath: string
      readonly scenario: UiSmokeScenario
    }

export function resolveUiSmokeMode(env: ApplicationEnvironment): UiSmokeMode {
  if (env['AGENT_SQUAD_HQ_UI_TEST'] !== '1') return { enabled: false }

  const userDataPath = env['AGENT_SQUAD_HQ_UI_TEST_USER_DATA_DIR']?.trim()
  if (!userDataPath || !isAbsolute(userDataPath)) {
    throw new Error(
      'AGENT_SQUAD_HQ_UI_TEST_USER_DATA_DIR must be an absolute path'
    )
  }

  return {
    enabled: true,
    userDataPath,
    scenario: UI_SMOKE_SCENARIO
  }
}
