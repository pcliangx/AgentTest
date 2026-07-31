/// <reference types="vite/client" />

declare interface AgentEventView {
  kind: string
  occurredAt: number
  source: string
  payload: unknown
}
declare type RunStartResult =
  | { ok: true }
  | {
      ok: false
      reason: 'busy' | 'unknown-agent' | 'start-failed' | 'terminal-active'
    }
declare type TerminalOpenResult =
  | { ok: true }
  | {
      ok: false
      reason: 'unknown-agent' | 'structured-run-active' | 'spawn-failed'
    }

declare type PickRepoResult = { ok: true; name: string } | { ok: false; reason: string }
declare interface WorktreeFile {
  path: string
  flag: string
}
declare interface WorktreeStatus {
  exists: boolean
  files: WorktreeFile[]
  summary: string | null
}
declare type ApplyResult = { ok: true; branch: string } | { ok: false; reason: string }

declare interface Window {
  api: {
    run: (target: string, text: string) => Promise<RunStartResult>
    cancel: (target: string) => Promise<boolean>
    terminalOpen: (target: string) => Promise<TerminalOpenResult>
    terminalClose: (target: string) => Promise<boolean>
    ptyInput: (target: string, data: string) => void
    ptyResize: (target: string, cols: number, rows: number) => void
    onPtyData: (cb: (p: { target: string; data: string }) => void) => () => void
    onAgentEvent: (cb: (p: { target: string; event: AgentEventView }) => void) => () => void
    pickRepo: () => Promise<PickRepoResult>
    getCurrentRepo: () => Promise<{ name: string } | null>
    worktreeStatus: (target: string) => Promise<WorktreeStatus>
    worktreeOpen: (target: string) => Promise<boolean>
    worktreeApply: (target: string) => Promise<ApplyResult>
  }
}
