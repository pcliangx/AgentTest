import type { IpcMain } from 'electron'
import { startDummyRun } from './run-manager'

// IPC surface (Phase 0):
//   renderer -> main:  agent:run   { target, text }
//   main -> renderer:  agent:event { target, event }
//
// Phase 1 will route through MessageRouter (@@ parsing lives in the renderer for now) and
// WorktreeManager before spawning; the handler signature stays stable.
export function registerIpc(ipcMain: IpcMain): void {
  ipcMain.on('agent:run', (event, payload: { target: string; text: string }) => {
    const { target } = payload
    const send = (event2: AgentEventLike) => event.sender.send('agent:event', { target, event: event2 })

    startDummyRun({
      target,
      cwd: process.cwd(),
      onEvent: send,
      onExit: (code) =>
        send({ kind: 'process-exited', occurredAt: Date.now(), source: 'inferred', payload: { code } })
    })
  })
}

interface AgentEventLike {
  kind: string
  occurredAt: number
  source: string
  payload: unknown
}
