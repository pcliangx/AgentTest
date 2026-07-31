import type { IpcMain, WebContents } from 'electron'
import type { AgentId } from './adapters/contract'
import { PtyManager } from './pty-manager'
import { WorktreeManager } from './worktree-manager'
import { getDefaultBaseRepo } from './workspace'

// PTY-primary IPC (ADR-0001 updated): the @@ bar and direct terminal typing both write into the
// target agent's long-lived PTY; agent TUI output streams back as terminal bytes (xterm renders).
let worktrees: WorktreeManager
let ptys: PtyManager
let sender: WebContents | null = null

export function initServices(userDataDir: string): void {
  worktrees = new WorktreeManager(`${userDataDir}/worktrees`)
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

export function registerIpc(ipcMain: IpcMain): void {
  ipcMain.on('agent:run', (event, payload: { target: string; text: string }) => {
    sender = event.sender
    const { target, text } = payload
    if (!isAgentId(target)) {
      event.sender.send('agent:error', { target, message: `unknown @@${target}` })
      return
    }
    ptys.write(target, `${text}\r`)
  })

  ipcMain.on('agent:pty:input', (event, payload: { target: string; data: string }) => {
    sender = event.sender
    if (isAgentId(payload.target)) ptys.write(payload.target, payload.data)
  })

  ipcMain.on('agent:pty:resize', (event, payload: { target: string; cols: number; rows: number }) => {
    sender = event.sender
    if (isAgentId(payload.target)) ptys.resize(payload.target, payload.cols, payload.rows)
  })
}
