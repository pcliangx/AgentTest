import type { IpcMain } from 'electron'
import { getAdapter } from './adapters/registry'
import type { AgentEvent, AgentId } from './adapters/contract'
import { SessionStore } from './session-store'
import { WorktreeManager } from './worktree-manager'
import { getDefaultBaseRepo } from './workspace'
import { startRun } from './run-manager'

let sessionStore: SessionStore
let worktrees: WorktreeManager

/** Call once from app.whenReady with app.getPath('userData'). */
export function initServices(userDataDir: string): void {
  sessionStore = new SessionStore(`${userDataDir}/sessions.json`)
  worktrees = new WorktreeManager(`${userDataDir}/worktrees`)
}

export function registerIpc(ipcMain: IpcMain): void {
  ipcMain.on('agent:run', (event, payload: { target: string; text: string }) => {
    const target = payload.target as AgentId
    const adapter = getAdapter(target)
    const send = (e: AgentEvent): void => event.sender.send('agent:event', { target, event: e })

    if (!adapter) {
      send({
        kind: 'error',
        occurredAt: Date.now(),
        source: 'inferred',
        payload: { message: `no adapter registered for @@${target} yet (Phase 1 only ships claude)` }
      })
      return
    }

    const cwd = worktrees.ensureWorktree(getDefaultBaseRepo(), target)
    const nativeSessionId = sessionStore.get(target) // undefined => fresh start

    startRun({
      adapter,
      cwd,
      text: payload.text,
      nativeSessionId,
      onEvent: (e) => {
        // Persist the native conversation id as soon as we see it, so the next @@<target> resumes.
        if (e.kind === 'session-identified') {
          const sid = (e.payload as { sessionId?: string }).sessionId
          if (sid) sessionStore.set(target, sid)
        }
        send(e)
      },
      onExit: (code) =>
        send({ kind: 'process-exited', occurredAt: Date.now(), source: 'inferred', payload: { code } })
    })
  })
}
