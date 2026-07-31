import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { realpathSync } from 'node:fs'
import { BrowserWindow, dialog, type IpcMain, type OpenDialogOptions, type WebContents } from 'electron'
import type { AgentId } from './adapters/contract'
import { PtyManager } from './pty-manager'
import { WorktreeManager } from './worktree-manager'
import { getDefaultBaseRepo, setBaseRepo } from './workspace'
import { TranscriptWatcher } from './transcript-watcher'
import { claudeProjectDir, mapClaudeTranscript } from './adapters/claude/transcribe'
import { SettingsStore } from './settings'

// PTY = live TUI (agent:pty:data). Transcript sidecar = structured data (agent:transcript:event).
// repo:pick / repo:current manage the base repo that worktrees branch from (RepoPicker). Only the
// repo NAME is returned to the renderer; the full path stays in main.
let worktrees: WorktreeManager
let ptys: PtyManager
let settings: SettingsStore
let sender: WebContents | null = null
const transcripts = new Map<AgentId, TranscriptWatcher>()

export function initServices(userDataDir: string): void {
  settings = new SettingsStore(`${userDataDir}/settings.json`)
  setBaseRepo(settings.baseRepo)
  worktrees = new WorktreeManager(`${userDataDir}/worktrees`)
  stopAllTranscripts()
  ptys = new PtyManager(
    (agent) => worktrees.ensureWorktree(getDefaultBaseRepo(), agent),
    (agent, data) => {
      if (sender && !sender.isDestroyed()) sender.send('agent:pty:data', { target: agent, data })
    },
    (agent, code) => {
      if (sender && !sender.isDestroyed()) {
        sender.send('agent:pty:data', { target: agent, data: `\r\n\r\n[process exited · code ${code}]\r\n` })
      }
    }
  )
}

function stopAllTranscripts(): void {
  for (const w of transcripts.values()) w.stop()
  transcripts.clear()
}

function isAgentId(x: string): x is AgentId {
  return x === 'claude' || x === 'codex' || x === 'kimi'
}

function ensureTranscript(target: AgentId): void {
  if (target !== 'claude') return // claude only for now; codex/kimi later
  if (transcripts.has(target)) return
  // claude names its projects dir by the REAL (symlink-resolved) cwd, so realpath here to match.
  const cwd = realpathSync(worktrees.ensureWorktree(getDefaultBaseRepo(), target))
  const watcher = new TranscriptWatcher(
    { dir: claudeProjectDir(cwd), map: mapClaudeTranscript },
    (e) => {
      if (sender && !sender.isDestroyed()) sender.send('agent:transcript:event', { target, event: e })
    }
  )
  watcher.start()
  transcripts.set(target, watcher)
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function registerIpc(ipcMain: IpcMain): void {
  ipcMain.on('agent:run', (event, payload: { target: string; text: string }) => {
    sender = event.sender
    const { target, text } = payload
    if (!isAgentId(target)) {
      event.sender.send('agent:error', { target, message: `unknown @@${target}` })
      return
    }
    ensureTranscript(target)
    ptys.write(target, `${text}\r`)
  })

  ipcMain.on('agent:pty:input', (event, payload: { target: string; data: string }) => {
    sender = event.sender
    if (isAgentId(payload.target)) {
      ensureTranscript(payload.target)
      ptys.write(payload.target, payload.data)
    }
  })

  ipcMain.on('agent:pty:resize', (event, payload: { target: string; cols: number; rows: number }) => {
    sender = event.sender
    if (isAgentId(payload.target)) ptys.resize(payload.target, payload.cols, payload.rows)
  })

  ipcMain.handle('repo:current', () => {
    const p = settings.baseRepo
    return p ? { name: basename(p) } : null
  })

  ipcMain.handle('repo:pick', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const dialogOpts: OpenDialogOptions = { properties: ['openDirectory'], title: '选择一个 git 仓库' }
    const res = win
      ? await dialog.showOpenDialog(win, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts)
    if (res.canceled || res.filePaths.length === 0) return { ok: false as const, reason: 'canceled' }
    const dir = res.filePaths[0]
    if (!isGitRepo(dir)) return { ok: false as const, reason: 'not a git repo' }
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    settings.setBaseRepo(top)
    setBaseRepo(top)
    // Reset workspaces so agents re-launch in worktrees of the new repo.
    ptys.disposeAll()
    worktrees.clearAll()
    stopAllTranscripts()
    return { ok: true as const, name: basename(top) }
  })
}
