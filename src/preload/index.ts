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

contextBridge.exposeInMainWorld('api', {
  run: (target: string, text: string): void => {
    ipcRenderer.send('agent:run', { target, text })
  },
  ptyInput: (target: string, data: string): void => {
    ipcRenderer.send('agent:pty:input', { target, data })
  },
  ptyResize: (target: string, cols: number, rows: number): void => {
    ipcRenderer.send('agent:pty:resize', { target, cols, rows })
  },
  onPtyData: (cb: (p: { target: string; data: string }) => void): (() => void) => {
    const h = (_e: unknown, p: { target: string; data: string }): void => cb(p)
    ipcRenderer.on('agent:pty:data', h)
    return () => {
      ipcRenderer.off('agent:pty:data', h)
    }
  },
  onTranscript: (cb: (p: { target: string; event: unknown }) => void): (() => void) => {
    const h = (_e: unknown, p: { target: string; event: unknown }): void => cb(p)
    ipcRenderer.on('agent:transcript:event', h)
    return () => {
      ipcRenderer.off('agent:transcript:event', h)
    }
  },
  onError: (cb: (p: { target: string; message: string }) => void): (() => void) => {
    const h = (_e: unknown, p: { target: string; message: string }): void => cb(p)
    ipcRenderer.on('agent:error', h)
    return () => {
      ipcRenderer.off('agent:error', h)
    }
  },
  pickRepo: (): Promise<PickRepoResult> => ipcRenderer.invoke('repo:pick'),
  getCurrentRepo: (): Promise<{ name: string } | null> => ipcRenderer.invoke('repo:current'),
  worktreeStatus: (target: string): Promise<WorktreeStatus> => ipcRenderer.invoke('worktree:status', { target }),
  worktreeOpen: (target: string): Promise<boolean> => ipcRenderer.invoke('worktree:open', { target })
})
