import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isRealCliE2EEnabled,
  prepareApplicationDataDirectory,
  resolveBaseRepositoryOverride
} from './app-identity'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryAppDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-squad-hq-identity-test-'))
  temporaryRoots.push(root)
  return root
}

describe('application environment compatibility', () => {
  it('prefers the Agent Squad HQ base repository override over the legacy name', () => {
    expect(
      resolveBaseRepositoryOverride({
        AGENT_SQUAD_HQ_BASE_REPO: '/repos/current',
        AGENTTEST_BASE_REPO: '/repos/legacy'
      })
    ).toBe('/repos/current')
  })

  it('accepts the legacy base repository override when the new name is absent', () => {
    expect(resolveBaseRepositoryOverride({ AGENTTEST_BASE_REPO: '/repos/legacy' })).toBe('/repos/legacy')
  })

  it('treats an explicitly empty new base repository override as disabled', () => {
    expect(
      resolveBaseRepositoryOverride({ AGENT_SQUAD_HQ_BASE_REPO: '', AGENTTEST_BASE_REPO: '/repos/legacy' })
    ).toBeUndefined()
  })

  it('does not let the legacy E2E flag override an explicit new-name opt-out', () => {
    expect(isRealCliE2EEnabled({ AGENT_SQUAD_HQ_E2E: '0', AGENTTEST_E2E: '1' })).toBe(false)
  })

  it('accepts the legacy E2E opt-in when the new flag is absent', () => {
    expect(isRealCliE2EEnabled({ AGENTTEST_E2E: '1' })).toBe(true)
  })
})

describe('application data migration', () => {
  it('creates the stable Agent Squad HQ data directory for a fresh installation', () => {
    const appDataRoot = temporaryAppDataRoot()

    const result = prepareApplicationDataDirectory(appDataRoot)

    expect(result).toEqual({ path: join(appDataRoot, 'agent-squad-hq'), status: 'created' })
    expect(existsSync(result.path)).toBe(true)
  })

  it('keeps an existing Agent Squad HQ data directory unchanged', () => {
    const appDataRoot = temporaryAppDataRoot()
    const currentPath = join(appDataRoot, 'agent-squad-hq')
    const legacyPath = join(appDataRoot, 'agenttest')
    mkdirSync(currentPath)
    mkdirSync(legacyPath)
    writeFileSync(join(currentPath, 'settings.json'), 'current')
    writeFileSync(join(legacyPath, 'settings.json'), 'legacy')

    const result = prepareApplicationDataDirectory(appDataRoot)

    expect(result).toEqual({ path: currentPath, status: 'current' })
    expect(readFileSync(join(currentPath, 'settings.json'), 'utf8')).toBe('current')
    expect(readFileSync(join(legacyPath, 'settings.json'), 'utf8')).toBe('legacy')
  })

  it('copies legacy AgentTest data into the stable directory without deleting the source', () => {
    const appDataRoot = temporaryAppDataRoot()
    const legacyPath = join(appDataRoot, 'agenttest')
    mkdirSync(legacyPath)
    writeFileSync(join(legacyPath, 'settings.json'), 'legacy')

    const result = prepareApplicationDataDirectory(appDataRoot)

    expect(result).toEqual({ path: join(appDataRoot, 'agent-squad-hq'), status: 'migrated' })
    expect(readFileSync(join(result.path, 'settings.json'), 'utf8')).toBe('legacy')
    expect(readFileSync(join(legacyPath, 'settings.json'), 'utf8')).toBe('legacy')

    expect(prepareApplicationDataDirectory(appDataRoot)).toEqual({ path: result.path, status: 'current' })
  })

  it('leaves linked worktrees in the legacy directory instead of duplicating their Git metadata', () => {
    const appDataRoot = temporaryAppDataRoot()
    const legacyPath = join(appDataRoot, 'agenttest')
    const legacyWorktreePath = join(legacyPath, 'worktrees', 'claude')
    mkdirSync(legacyWorktreePath, { recursive: true })
    writeFileSync(join(legacyWorktreePath, '.git'), 'gitdir: /repos/base/.git/worktrees/claude')
    writeFileSync(join(legacyPath, 'agent-sessions.json'), '{}')

    const result = prepareApplicationDataDirectory(appDataRoot)

    expect(existsSync(join(result.path, 'worktrees'))).toBe(false)
    expect(readFileSync(join(legacyWorktreePath, '.git'), 'utf8')).toContain('/repos/base/.git/worktrees/claude')
    expect(readFileSync(join(result.path, 'agent-sessions.json'), 'utf8')).toBe('{}')
  })
})
