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
 *
 * New providers: add an entry to PROVIDER_ICON_CONFIG and a Mark component;
 * the agent-display.ts PROVIDER_LABEL/CODE tables should already list the id.
 */

type MarkKind = 'sparkle' | 'hexagon' | 'crescent' | 'gem'

interface ProviderIconConfig {
  /** Short key for the @theme colour tokens (--color-provider-<short>). */
  short: string
  /** Which original SVG geometric mark to render. */
  mark: MarkKind
}

const PROVIDER_ICON_CONFIG: Record<string, ProviderIconConfig> = {
  'claude-code': { short: 'cc', mark: 'sparkle' },
  codex: { short: 'cx', mark: 'hexagon' },
  'kimi-code': { short: 'km', mark: 'crescent' },
  'gemini-cli': { short: 'gm', mark: 'gem' }
}

const MARKS: Record<MarkKind, (props: { color: string; size: number }) => React.JSX.Element> = {
  sparkle: ClaudeCodeMark,
  hexagon: CodexMark,
  crescent: KimiCodeMark,
  gem: GeminiMark
}

export function ProviderIcon({
  providerId,
  size = 31,
  className = ''
}: {
  providerId: AgentProviderId
  size?: number
  className?: string
}): React.JSX.Element {
  const config = PROVIDER_ICON_CONFIG[providerId]

  // Fallback for unknown / future providers.
  if (!config) {
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

  const Mark = MARKS[config.mark]
  return (
    <span
      aria-hidden="true"
      className={`grid place-items-center rounded-lg ${className}`}
      style={{
        width: size,
        height: size,
        background: `var(--color-provider-${config.short}-soft)`
      }}
    >
      <Mark
        color={`var(--color-provider-${config.short})`}
        size={size}
      />
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
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
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
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7L12 2.5Z"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M12 8 16 10.25v4.5L12 17l-4-2.25v-4.5L12 8Z" fill={color} />
    </svg>
  )
}

/** Kimi Code: a crescent moon (deep blue). */
function KimiCodeMark({ color, size }: { color: string; size: number }) {
  const s = size * 0.5
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M16.5 3.5a8.5 8.5 0 1 0 4 11.2 6.5 6.5 0 0 1-4-11.2Z"
        fill={color}
      />
    </svg>
  )
}

/** Gemini CLI: a faceted gem (teal). */
function GeminiMark({ color, size }: { color: string; size: number }) {
  const s = size * 0.5
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M6 3h12l3 5-9 13L3 8l3-5Z"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M3 8h18M9 3l-3 5 6 13 6-13-3-5" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}
