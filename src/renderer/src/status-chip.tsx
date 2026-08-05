import type { ReactNode } from 'react'

/**
 * The shared status chip for non-Agent state badges (#69), sibling to the
 * #65 StatusDot: Tasks sync/review, Knowledge container state, Handoff
 * completeness/validation, Activity kinds, Connection and Provider health
 * all render through this one component so tone classes and the icon rule
 * can never drift apart.
 *
 * UX-v0.2 §15: a state never depends on color alone. The text always names
 * the state; the icon is decorative (aria-hidden) and only adds the third
 * visual channel on top of color + text.
 */
export type StatusChipTone = 'neutral' | 'brand' | 'good' | 'warn' | 'danger'

const TONE_CLASS: Record<StatusChipTone, string> = {
  neutral: 'chip',
  brand: 'chip chip-brand',
  good: 'chip chip-good',
  warn: 'chip chip-warn',
  danger: 'chip chip-danger'
}

export function StatusChip({
  tone = 'neutral',
  icon,
  children
}: {
  tone?: StatusChipTone
  /** Decorative glyph (✓ ⚠ ✕ ● ◌ …), hidden from assistive tech. */
  icon?: string
  children: ReactNode
}) {
  return (
    <span className={TONE_CLASS[tone]}>
      {icon !== undefined && <span aria-hidden="true">{icon}</span>}
      {/* The label keeps its own text node so exact-text queries (and AT)
          always see the state name alone, never prefixed by the glyph. */}
      <span>{children}</span>
    </span>
  )
}
