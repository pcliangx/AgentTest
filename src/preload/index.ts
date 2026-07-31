import { contextBridge, ipcRenderer } from 'electron'

export type PickRepoResult = { ok: true; name: string } | { ok: false; reason: string }
export interface WorktreeFile {
  path: string
  flag: string
}
export interface WorktreeStatus {
  exists: boolean
  files: WorktreeFile[]
  summary: string | null
}
export type ApplyResult = { ok: true; branch: string } | { ok: false; reason: string }
export type RunStartResult =
  | { ok: true }
  | {
      ok: false
      reason: 'busy' | 'unknown-agent' | 'start-failed' | 'terminal-active'
    }
export type TerminalOpenResult =
  | { ok: true }
  | {
      ok: false
      reason: 'unknown-agent' | 'structured-run-active' | 'spawn-failed'
    }

contextBridge.exposeInMainWorld('api', {
  run: (target: string, text: string): Promise<RunStartResult> =>
    ipcRenderer.invoke('agent:run', { target, text }),
  cancel: (target: string): Promise<boolean> => ipcRenderer.invoke('agent:cancel', { target }),
  terminalOpen: (target: string): Promise<TerminalOpenResult> =>
    ipcRenderer.invoke('agent:terminal:open', { target }),
  terminalClose: (target: string): Promise<boolean> =>
    ipcRenderer.invoke('agent:terminal:close', { target }),
  ptyInput: (target: string, data: string): void => {
    ipcRenderer.send('agent:pty:input', { target, data })
  },
  ptyResize: (target: string, cols: number, rows: number): void => {
    ipcRenderer.send('agent:pty:resize', { target, cols, rows })
  },
  onPtyData: (cb: (payload: { target: string; data: string }) => void): (() => void) => {
    const handler = (_event: unknown, payload: { target: string; data: string }): void =>
      cb(payload)
    ipcRenderer.on('agent:pty:data', handler)
    return () => ipcRenderer.off('agent:pty:data', handler)
  },
  onAgentEvent: (
    cb: (payload: { target: string; event: unknown }) => void
  ): (() => void) => {
    const handler = (_event: unknown, payload: { target: string; event: unknown }): void =>
      cb(payload)
    ipcRenderer.on('agent:event', handler)
    return () => ipcRenderer.off('agent:event', handler)
  },
  pickRepo: (): Promise<PickRepoResult> => ipcRenderer.invoke('repo:pick'),
  getCurrentRepo: (): Promise<{ name: string } | null> => ipcRenderer.invoke('repo:current'),
  worktreeStatus: (target: string): Promise<WorktreeStatus> =>
    ipcRenderer.invoke('worktree:status', { target }),
  worktreeOpen: (target: string): Promise<boolean> =>
    ipcRenderer.invoke('worktree:open', { target }),
  worktreeApply: (target: string): Promise<ApplyResult> =>
    ipcRenderer.invoke('worktree:apply', { target })
})
