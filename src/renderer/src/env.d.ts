/// <reference types="vite/client" />

// Event shape as seen across the IPC boundary (structural; main's AgentEvent is a richer union).
declare interface AgentEventView {
  kind: string
  occurredAt: number
  source: string
  payload: unknown
}

declare interface Window {
  api: {
    run: (target: string, text: string) => void
    onEvent: (cb: (payload: { target: string; event: AgentEventView }) => void) => () => void
  }
}
