// Polling tail of a transcript directory. Robust against fs.watch flakiness and late file creation.
// Finds the session file created around `start`, then tails new bytes, parsing one JSON record per line.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from './adapters/contract'

export interface TranscriptWatch {
  /** Directory holding <sessionId>.jsonl files (e.g. ~/.claude/projects/<encoded-cwd>). */
  readonly dir: string
  /** Map one parsed record to zero or more events. */
  readonly map: (raw: unknown) => readonly AgentEvent[]
}

export class TranscriptWatcher {
  private file: string | null = null
  private size = 0
  private buf = ''
  private timer: NodeJS.Timeout | null = null
  private readonly startEpoch = Date.now()

  constructor(
    private readonly spec: TranscriptWatch,
    private readonly onEvent: (event: AgentEvent) => void,
    private readonly intervalMs = 400
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch {
        // best-effort: a transient fs error just skips this tick
      }
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private tick(): void {
    if (!existsSync(this.spec.dir)) return

    if (!this.file) {
      // Pick the session file created around our start time (the new session).
      const files = readdirSync(this.spec.dir).filter((f) => f.endsWith('.jsonl'))
      let newest = ''
      let mtime = 0
      for (const f of files) {
        const st = statSync(join(this.spec.dir, f))
        if (st.ctimeMs < this.startEpoch - 2000) continue // older session -> ignore
        if (st.mtimeMs > mtime) {
          mtime = st.mtimeMs
          newest = f
        }
      }
      if (!newest) return
      this.file = join(this.spec.dir, newest)
      this.size = 0 // read from the start of the new session
    }

    const st = statSync(this.file)
    if (st.size <= this.size) return

    const len = st.size - this.size
    const fd = openSync(this.file, 'r')
    try {
      const chunk = Buffer.allocUnsafe(len)
      readSync(fd, chunk, 0, len, this.size)
      this.size = st.size
      this.buf += chunk.toString('utf8')
    } finally {
      closeSync(fd)
    }

    let nl = this.buf.indexOf('\n')
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      nl = this.buf.indexOf('\n')
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        for (const e of this.spec.map(obj)) this.onEvent(e)
      } catch {
        // skip malformed line
      }
    }

    // The transcript's final record may have no trailing newline; try to parse the leftover buffer
    // (fails harmlessly while it is still incomplete).
    if (this.buf.length > 0) {
      const line = this.buf.trim()
      try {
        const obj = JSON.parse(line)
        for (const e of this.spec.map(obj)) this.onEvent(e)
        this.buf = ''
      } catch {
        // incomplete — wait for more bytes
      }
    }
  }
}
