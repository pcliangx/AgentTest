import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import {
  BrowserWindow,
  dialog,
  shell,
  type IpcMain,
  type OpenDialogOptions,
  type WebContents
} from 'electron'
import type { AgentId } from './adapters/contract'
import { isAgentId } from './adapters/registry'
import { AgentRuntime, type RunStartResult } from './agent-runtime'
import { PtyManager } from './pty-manager'
import { SessionStore } from './session-store'
import { SettingsStore } from './settings'
import { WorktreeManager } from './worktree-manager'
import { getDefaultBaseRepo, setBaseRepo } from './workspace'

let worktrees: WorktreeManager
let ptys: PtyManager
let runtime: AgentRuntime
let sessions: SessionStore
let settings: SettingsStore
let sender: WebContents | null = null

export type IpcRunStartResult =
  | RunStartResult
  | { readonly ok: false; readonly reason: 'terminal-active' }

export function initServices(userDataDir: string): void {
  settings = new SettingsStore(`${userDataDir}/settings.json`)
  setBaseRepo(settings.baseRepo)
  worktrees = new WorktreeManager(`${userDataDir}/worktrees`)
  sessions = new SessionStore(`${userDataDir}/agent-sessions.json`)
  ptys = new PtyManager(
    (agent) => worktrees.ensureWorktree(getDefaultBaseRepo(), agent),
    (agent, data) => {
      if (sender && !sender.isDestroyed()) sender.send('agent:pty:data', { target: agent, data })
    },
    (agent, code) => {
      if (sender && !sender.isDestroyed()) {
        sender.send('agent:pty:data', {
          target: agent,
          data: `\r\n\r\n[process exited · code ${code}]\r\n`
        })
      }
    }
  )
  runtime = new AgentRuntime({
    resolveCwd: (agent) => worktrees.ensureWorktree(getDefaultBaseRepo(), agent),
    sessionStore: sessions,
    onEvent: (target, event) => {
      if (sender && !sender.isDestroyed()) sender.send('agent:event', { target, event })
    }
  })
}

export async function disposeServices(): Promise<void> {
  ptys?.disposeAll()
  await runtime?.disposeAll()
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

function runFailure(
  reason: 'busy' | 'unknown-agent' | 'start-failed' | 'terminal-active'
): IpcRunStartResult {
  return { ok: false, reason }
}

export function registerIpc(ipcMain: IpcMain): void {
  ipcMain.handle(
    'agent:run',
    (event, payload: { target: string; text: string }): IpcRunStartResult => {
      sender = event.sender
      if (!isAgentId(payload.target)) return runFailure('unknown-agent')
      if (ptys.has(payload.target)) return runFailure('terminal-active')
      return runtime.run(payload.target, payload.text)
    }
  )

  ipcMain.handle('agent:cancel', (event, payload: { target: string }): boolean => {
    sender = event.sender
    return isAgentId(payload.target) ? runtime.cancel(payload.target) : false
  })

  ipcMain.handle(
    'agent:terminal:open',
    (
      event,
      payload: { target: string }
    ): { ok: true } | { ok: false; reason: 'unknown-agent' | 'structured-run-active' | 'spawn-failed' } => {
      sender = event.sender
      if (!isAgentId(payload.target)) return { ok: false, reason: 'unknown-agent' }
      if (runtime.isRunning(payload.target)) {
        return { ok: false, reason: 'structured-run-active' }
      }
      try {
        ptys.ensure(payload.target)
        return { ok: true }
      } catch {
        return { ok: false, reason: 'spawn-failed' }
      }
    }
  )

  ipcMain.handle('agent:terminal:close', (_event, payload: { target: string }): boolean => {
    if (!isAgentId(payload.target)) return false
    ptys.dispose(payload.target)
    return true
  })

  ipcMain.on('agent:pty:input', (event, payload: { target: string; data: string }) => {
    sender = event.sender
    if (isAgentId(payload.target) && ptys.has(payload.target)) {
      ptys.write(payload.target, payload.data)
    }
  })

  ipcMain.on(
    'agent:pty:resize',
    (event, payload: { target: string; cols: number; rows: number }) => {
      sender = event.sender
      if (isAgentId(payload.target) && ptys.has(payload.target)) {
        ptys.resize(payload.target, payload.cols, payload.rows)
      }
    }
  )

  ipcMain.handle('repo:current', () => {
    const path = settings.baseRepo
    return path ? { name: basename(path) } : null
  })

  ipcMain.handle('repo:pick', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const dialogOptions: OpenDialogOptions = {
      properties: ['openDirectory'],
      title: '选择一个 git 仓库'
    }
    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false as const, reason: 'canceled' }
    }
    const dir = result.filePaths[0]
    if (!isGitRepo(dir)) return { ok: false as const, reason: 'not a git repo' }
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8'
    }).trim()

    await runtime.disposeAll()
    ptys.disposeAll()
    worktrees.clearAll()
    sessions.clearAll()
    settings.setBaseRepo(top)
    setBaseRepo(top)
    return { ok: true as const, name: basename(top) }
  })

  ipcMain.handle('worktree:status', (_event, payload: { target: string }) => {
    if (!isAgentId(payload.target)) return { exists: false, files: [], summary: null }
    return worktrees.status(payload.target)
  })

  ipcMain.handle('worktree:open', async (_event, payload: { target: string }) => {
    if (!isAgentId(payload.target)) return false
    const error = await shell.openPath(worktrees.pathFor(payload.target))
    return error === ''
  })

  ipcMain.handle('worktree:apply', (_event, payload: { target: string }) => {
    if (!isAgentId(payload.target)) {
      return { ok: false as const, reason: 'no-worktree' as const }
    }
    return worktrees.applyToBase(payload.target, getDefaultBaseRepo())
  })
}
