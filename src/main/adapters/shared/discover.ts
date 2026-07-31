import { execFileSync } from 'node:child_process'

/** Resolve an executable's full path via `which`; fall back to the bare name (relies on spawn PATH). */
export function discoverExecutable(name: string): string {
  try {
    return (
      execFileSync('which', [name], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        env: process.env
      }).trim() || name
    )
  } catch {
    return name
  }
}
