import { realpathSync } from 'node:fs'
import type { IpcMain, WebContents } from 'electron'
import type { AgentId } from './adapters/contract'
import { PtyManager } from './pty-manager'
import { WorktreeManager } from './worktree-manager'
import { getDefaultBaseRepo } from './workspace'
import { TranscriptWatcher } from './transcript-watcher'
import { claudeProjectDir, mapClaudeTranscript } from './adapters/claude/transcribe'

// PTY = live TUI (agent:pty:data). Transcript sidecar = structured data (agent:transcript:event):
// tails ~/.claude/projects/<realpath-cwd>/<sid>.jsonl and emits messages/usage/tool/session/turn.
let worktrees: WorktreeManager
let ptys: PtyManager
let sender: WebContents | null = null
const transcripts = new Map<AgentId, TranscriptWatcher>()

export function initServices(userDataDir: string): void {
  worktrees = new WorktreeManager(`${userDataDir}/worktrees`)
  for (const w of transcripts.values()) w.stop()
  transcripts.clear()
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
}
