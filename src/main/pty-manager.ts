import { spawn as ptySpawn, type IPty } from 'node-pty'
import type { AgentId } from './adapters/contract'
import { discoverExecutable } from './adapters/shared/discover'

// Interactive (long-lived) PTY per agent — the architecture doc's 方案 A channel. Each agent runs
// its native TUI; follow-ups are just typing into the same process (model-2 §4.1 over PTY), so no
// cold start and full streaming. Spawned in an isolated worktree (ADR-0002), with per-agent
// autonomy flags (ADR-0003).
const SPECS: Record<AgentId, { readonly exe: string; readonly args: readonly string[] }> = {
  claude: { exe: discoverExecutable('claude'), args: ['--dangerously-skip-permissions'] },
  codex: { exe: discoverExecutable('codex'), args: [] },
  kimi: { exe: discoverExecutable('kimi'), args: ['--yolo'] }
}

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

    const spec = SPECS[agent]
    const pty = ptySpawn(spec.exe, [...spec.args], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: this.resolveCwd(agent),
      env: cleanEnv()
    })
    pty.onData((data) => this.onData(agent, data))
    pty.onExit(({ exitCode }) => {
      this.ptys.delete(agent)
      this.onExit(agent, exitCode)
    })
    this.ptys.set(agent, pty)
    return pty
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
