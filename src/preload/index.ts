import { contextBridge, ipcRenderer } from 'electron'

// Minimal, explicit surface exposed to the renderer. No blanket require/fs/node leak.
contextBridge.exposeInMainWorld('api', {
  run: (target: string, text: string): void => {
    ipcRenderer.send('agent:run', { target, text })
  },
  onEvent: (cb: (payload: { target: string; event: unknown }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { target: string; event: unknown }): void => cb(payload)
    ipcRenderer.on('agent:event', handler)
    return () => ipcRenderer.off('agent:event', handler)
  }
})
