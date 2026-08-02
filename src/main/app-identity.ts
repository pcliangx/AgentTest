import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export type ApplicationEnvironment = Readonly<Record<string, string | undefined>>

export const APP_DISPLAY_NAME = 'Agent Squad HQ'
export const APP_TECHNICAL_NAME = 'agent-squad-hq'
export const APP_ID = 'com.pcliangx.agentsquadhq'
export const LEGACY_APP_TECHNICAL_NAME = 'agenttest'

export interface ApplicationDataPreparation {
  readonly path: string
  readonly status: 'created' | 'current' | 'migrated' | 'legacy-fallback'
}

function removeMigrationStagingDirectory(path: string | undefined): void {
  if (!path) return
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Best effort: the next migration uses a unique staging path and never treats this as current data.
  }
}

export function resolveBaseRepositoryOverride(env: ApplicationEnvironment): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, 'AGENT_SQUAD_HQ_BASE_REPO')) {
    return env['AGENT_SQUAD_HQ_BASE_REPO'] || undefined
  }
  return env['AGENTTEST_BASE_REPO'] || undefined
}

export function isRealCliE2EEnabled(env: ApplicationEnvironment): boolean {
  if (Object.prototype.hasOwnProperty.call(env, 'AGENT_SQUAD_HQ_E2E')) {
    return env['AGENT_SQUAD_HQ_E2E'] === '1'
  }
  return env['AGENTTEST_E2E'] === '1'
}

export function prepareApplicationDataDirectory(appDataRoot: string): ApplicationDataPreparation {
  const path = join(appDataRoot, APP_TECHNICAL_NAME)
  if (existsSync(path)) return { path, status: 'current' }

  const legacyPath = join(appDataRoot, LEGACY_APP_TECHNICAL_NAME)
  if (existsSync(legacyPath)) {
    const legacyWorktreesPath = join(legacyPath, 'worktrees')
    let stagingRoot: string | undefined
    try {
      stagingRoot = mkdtempSync(join(appDataRoot, `.${APP_TECHNICAL_NAME}-migration-`))
      const stagingPath = join(stagingRoot, APP_TECHNICAL_NAME)
      cpSync(legacyPath, stagingPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: (source) => source !== legacyWorktreesPath
      })
      renameSync(stagingPath, path)
      removeMigrationStagingDirectory(stagingRoot)
      return { path, status: 'migrated' }
    } catch {
      removeMigrationStagingDirectory(stagingRoot)
      if (existsSync(path)) return { path, status: 'current' }
      return { path: legacyPath, status: 'legacy-fallback' }
    }
  }

  mkdirSync(path, { recursive: true })
  return { path, status: 'created' }
}
