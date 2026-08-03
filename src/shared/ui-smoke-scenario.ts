export const UI_SMOKE_SCENARIO = {
  id: 'electron-smoke',
  clock: 1_700_000_000_000,
  viewport: { width: 1280, height: 800 },
  minimumPanelSize: { width: 224, height: 128 },
  networkEvidenceFile: 'blocked-network-requests.jsonl'
} as const

export type UiSmokeScenario = typeof UI_SMOKE_SCENARIO
