export const UI_SMOKE_SCENARIO = {
  id: 'electron-smoke',
  clock: 1_700_000_000_000,
  viewport: { width: 1280, height: 800 }
} as const

export type UiSmokeScenario = typeof UI_SMOKE_SCENARIO
