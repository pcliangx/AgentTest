import { execFileSync, spawnSync } from 'node:child_process'

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

/** Probe optional CLI flags without a shell; unsupported or broken CLIs are treated as false. */
export function executableHelpIncludes(
  executable: string,
  args: readonly string[],
  flag: string
): boolean {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 3_000
  })
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.includes(flag)
}
