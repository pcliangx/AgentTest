import { describe, expect, it } from 'vitest'
import { resolveUiSmokeMode } from './ui-smoke-mode'
import { UI_SMOKE_SCENARIO } from '../shared/ui-smoke-scenario'

describe('UI smoke launch mode', () => {
  it('uses the supplied isolated user data directory and deterministic scenario', () => {
    expect(
      resolveUiSmokeMode({
        AGENT_SQUAD_HQ_UI_TEST: '1',
        AGENT_SQUAD_HQ_UI_TEST_USER_DATA_DIR:
          '/tmp/agent-squad-hq-ui-smoke-example'
      })
    ).toEqual({
      enabled: true,
      userDataPath: '/tmp/agent-squad-hq-ui-smoke-example',
      scenario: UI_SMOKE_SCENARIO
    })
  })

  it('fails closed when UI smoke mode has no isolated user data directory', () => {
    expect(() =>
      resolveUiSmokeMode({ AGENT_SQUAD_HQ_UI_TEST: '1' })
    ).toThrow('AGENT_SQUAD_HQ_UI_TEST_USER_DATA_DIR must be an absolute path')
  })
})
