/// <reference types="vite/client" />

declare interface AgentEventView {
  kind: string
  occurredAt: number
  source: string
  payload: unknown
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

declare interface Window {
  api: {
    run: (target: string, text: string) => void
    ptyInput: (target: string, data: string) => void
    ptyResize: (target: string, cols: number, rows: number) => void
    onPtyData: (cb: (p: { target: string; data: string }) => void) => () => void
    onTranscript: (cb: (p: { target: string; event: AgentEventView }) => void) => () => void
    onError: (cb: (p: { target: string; message: string }) => void) => () => void
    pickRepo: () => Promise<PickRepoResult>
    getCurrentRepo: () => Promise<{ name: string } | null>
    worktreeStatus: (target: string) => Promise<WorktreeStatus>
    worktreeOpen: (target: string) => Promise<boolean>
  }
}
