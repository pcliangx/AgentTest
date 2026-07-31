// Bounded incremental JSONL decoder shared across adapters (doc §7.1/§14).
// Handles arbitrary byte chunking, oversized frames, non-JSON noise on stdout, partial frames.

const MAX_LINE = 1024 * 1024 // 1 MiB per line — protects against unbounded memory

export interface Decoded {
  readonly values: readonly unknown[]
  readonly warnings: readonly string[]
}

export class BoundedJsonlDecoder {
  private buffer = ''

  /** Feed a chunk of stdout bytes; return fully-parsed JSON values plus any warnings. */
  feed(chunk: Buffer): Decoded {
    const warnings: string[] = []
    const values: unknown[] = []
    this.buffer += chunk.toString('utf8')

    let nl = this.buffer.indexOf('\n')
    while (nl >= 0) {
      let line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)

      if (line.length > MAX_LINE) {
        warnings.push(`line exceeded ${MAX_LINE} bytes, truncated`)
        line = line.slice(0, MAX_LINE)
      }

      line = line.trim()
      if (line.length === 0) {
        nl = this.buffer.indexOf('\n')
        continue
      }

      try {
        values.push(JSON.parse(line))
      } catch {
        warnings.push(`non-JSON line skipped: ${line.slice(0, 120)}`)
      }
      nl = this.buffer.indexOf('\n')
    }

    // Guard against a runaway line with no trailing newline.
    if (this.buffer.length > MAX_LINE) {
      warnings.push(`buffer exceeded ${MAX_LINE} bytes without newline, truncated`)
      this.buffer = this.buffer.slice(-MAX_LINE)
    }

    return { values, warnings }
  }

  /** Parse a final unterminated frame after stdout closes. */
  flush(): Decoded {
    if (this.buffer.length === 0) return { values: [], warnings: [] }
    const buffer = this.buffer
    this.buffer = ''
    return this.feed(Buffer.from(`${buffer}\n`, 'utf8'))
  }
}
