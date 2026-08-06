import type { AgentProviderId } from './workbench/contract'
import { providerCode } from './agent-display'

/**
 * Shared Provider brand icons (#79). Each provider gets an original SVG
 * geometric abstraction on its brand-coloured background — never a copy of
 * a third-party trademark asset. The icon carries ONLY Provider identity;
 * runtime state still flows through StatusDot (#65 discipline, §15).
 *
 * The component is always `aria-hidden` because every usage site has
 * adjacent text naming the Provider. Unknown providers fall back to the
 * existing mono text block.
 */

const PROVIDER_ICONS = new Set([
  'claude-code',
  'codex',
  'kimi-code'
])

export function ProviderIcon({
  providerId,
  size = 31,
  className = ''
}: {
  providerId: AgentProviderId
  size?: number
  className?: string
}): React.JSX.Element {
  // Fallback for unknown / future providers.
  if (!PROVIDER_ICONS.has(providerId)) {
    return (
      <span
        aria-hidden="true"
        className={`grid place-items-center rounded-lg bg-brand-soft font-mono text-[9px] font-bold text-brand ${className}`}
        style={{ width: size, height: size }}
      >
        {providerCode(providerId)}
      </span>
    )
  }

  const bg = `var(--color-provider-${providerId === 'claude-code' ? 'cc' : providerId === 'codex' ? 'cx' : 'km'})`
  const soft = `var(--color-provider-${providerId === 'claude-code' ? 'cc' : providerId === 'codex' ? 'cx' : 'km'}-soft)`

  return (
    <span
      aria-hidden="true"
      className={`grid place-items-center rounded-lg ${className}`}
      style={{ width: size, height: size, background: soft }}
    >
      {providerId === 'claude-code' && <ClaudeCodeMark color={bg} size={size} />}
      {providerId === 'codex' && <CodexMark color={bg} size={size} />}
      {providerId === 'kimi-code' && <KimiCodeMark color={bg} size={size} />}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Original SVG geometric marks — not copied from any brand asset library.
// ---------------------------------------------------------------------------

/** Claude Code: a 4-pointed sparkle/asterisk (coral orange). */
function ClaudeCodeMark({ color, size }: { color: string; size: number }) {
  const s = size * 0.52
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 1.5c.4 4.2 2.3 6.1 6.5 6.5-4.2.4-6.1 2.3-6.5 6.5-.4-4.2-2.3-6.1-6.5-6.5 4.2-.4 6.1-2.3 6.5-6.5Z"
        fill={color}
      />
      <path
        d="M18 14c.2 2 1.1 2.9 3.1 3.1-2 .2-2.9 1.1-3.1 3.1-.2-2-1.1-2.9-3.1-3.1 2-.2 2.9-1.1 3.1-3.1Z"
        fill={color}
        opacity="0.7"
      />
    </svg>
  )
}

/** Codex: a hexagonal knot / interlinked hexagons (near-black). */
function CodexMark({ color, size }: { color: string; size: number }) {
  const s = size * 0.5
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7L12 2.5Z"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M12 8 16 10.25v4.5L12 17l-4-2.25v-4.5L12 8Z"
        fill={color}
      />
    </svg>
  )
}

/** Kimi Code: a crescent moon (deep blue). */
function KimiCodeMark({ color, size }: { color: string; size: number }) {
  const s = size * 0.5
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M16.5 3.5a8.5 8.5 0 1 0 4 11.2 6.5 6.5 0 0 1-4-11.2Z"
        fill={color}
      />
    </svg>
  )
}
