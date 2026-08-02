/**
 * Shared Agent Name rules for creation and `@@` routing (#6).
 *
 * CONTEXT.md only mandates that Agent Names be project-unique and
 * case-insensitive; it imposes no character-set restriction. This module
 * therefore does NOT tighten name syntax (rejecting spaces, punctuation or
 * non-ASCII would be an unauthorised change to the create-agent contract).
 *
 * The single shared rule relevant to #6 routing is the reserved broadcast
 * word `all`: a name literally called `all` would collide with the `@@all`
 * expansion token. Reserving it keeps routing unambiguous without narrowing
 * what names users may otherwise choose.
 */

/** Reserved broadcast token — never a valid Agent Name. */
export const RESERVED_NAME_ALL = 'all'

export interface NameValidation {
  ok: boolean
  reason?: string
}

/**
 * Validates a candidate Agent Name. Mirrors the original create-agent checks
 * (non-empty, project-unique is verified by the caller) plus the `all`
 * reservation that `@@` routing requires.
 */
export function validateAgentName(raw: string): NameValidation {
  const name = raw.trim()
  if (!name) return { ok: false, reason: 'Agent 名称不能为空' }
  if (name.toLowerCase() === RESERVED_NAME_ALL) {
    return { ok: false, reason: `Agent 名称不能使用保留词 "${name}"` }
  }
  return { ok: true }
}
