/**
 * Shared Agent Name rules for creation and `@@` routing (#6).
 *
 * CONTEXT.md only mandates that Agent Names be project-unique and
 * case-insensitive; it imposes no character-set restriction. This module
 * therefore does NOT tighten name syntax (rejecting spaces, punctuation or
 * non-ASCII would be an unauthorised change to the create-agent contract).
 */

export interface NameValidation {
  ok: boolean
  reason?: string
}

/**
 * Validates a candidate Agent Name. Project uniqueness is verified by the
 * caller. `all` remains a valid name under the accepted domain contract;
 * `@@all` has routing-syntax priority, while `@@{all}` or the visible Picker
 * entry addresses that exact instance.
 */
export function validateAgentName(raw: string): NameValidation {
  const name = raw.trim()
  if (!name) return { ok: false, reason: 'Agent 名称不能为空' }
  return { ok: true }
}
