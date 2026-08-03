import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  testMatch: 'electron-smoke.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  outputDir: 'test-results/ui-artifacts',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-results/ui-report', open: 'never' }]
  ]
})
