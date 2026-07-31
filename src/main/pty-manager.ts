import { spawn as ptySpawn, type IPty } from 'node-pty'
import type { AgentId } from './adapters/contract'
import { getAdapter } from './adapters/registry'

// Explicit Terminal/takeover channel (ADR-0007). Each agent runs its native TUI
// in the same isolated worktree used by structured Chat, so IPC must keep the
// two channels mutually exclusive.
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  return env
}

export class PtyManager {
  private readonly ptys = new Map<AgentId, IPty>()

  constructor(
    private readonly resolveCwd: (agent: AgentId) => string,
    private readonly onData: (agent: AgentId, data: string) => void,
    private readonly onExit: (agent: AgentId, code: number) => void
  ) {}

  ensure(agent: AgentId): IPty {
    const existing = this.ptys.get(agent)
    if (existing) return existing

    const adapter = getAdapter(agent)
    if (!adapter) throw new Error(`unknown agent: ${agent}`)
    const pty = ptySpawn(adapter.executable, [...adapter.terminalArgv], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: this.resolveCwd(agent),
      env: cleanEnv()
    })
    this.ptys.set(agent, pty)
    pty.onData((data) => {
      if (this.ptys.get(agent) === pty) this.onData(agent, data)
    })
    pty.onExit(({ exitCode }) => {
      if (this.ptys.get(agent) !== pty) return
      this.ptys.delete(agent)
      this.onExit(agent, exitCode)
    })
    return pty
  }

  has(agent: AgentId): boolean {
    return this.ptys.has(agent)
  }

  write(agent: AgentId, data: string): void {
    this.ensure(agent).write(data)
  }

  resize(agent: AgentId, cols: number, rows: number): void {
    this.ptys.get(agent)?.resize(cols, rows)
  }

  dispose(agent: AgentId): void {
    const p = this.ptys.get(agent)
    if (p) {
      p.kill()
      this.ptys.delete(agent)
    }
  }

  disposeAll(): void {
    for (const agent of [...this.ptys.keys()]) this.dispose(agent)
  }
}
