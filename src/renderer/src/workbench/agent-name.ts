/**
 * Shared Agent Name syntax rules (#6).
 *
 * Both agent creation (adapter) and `@@<agent-name>` routing (renderer) must
 * agree on what a valid, routable Agent Name looks like, otherwise a name the
 * UI accepts (`data review`, `all`, `name!`) cannot be reliably targeted.
 *
 * The rule is intentionally strict and stable across create + parse:
 *   - non-empty
 *   - only letters, digits, underscore and hyphen
 *   - not the reserved broadcast word `all` (any case)
 *
 * CONTEXT.md only mandates project-unique, case-insensitive names; this module
 * tightens the *syntax* so `@@` routing is deterministic. Real Agent Names are
 * matched exactly (longest-match is unnecessary because names cannot contain
 * whitespace or `@@`).
 */

/** Characters allowed in an Agent Name. */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

/** Reserved broadcast token — never a valid Agent Name. */
export const RESERVED_NAME_ALL = 'all'

export interface NameValidation {
  ok: boolean
  reason?: string
}

/** Validates a candidate Agent Name against the shared syntax. */
export function validateAgentName(raw: string): NameValidation {
  const name = raw.trim()
  if (!name) return { ok: false, reason: 'Agent 名称不能为空' }
  if (!AGENT_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason:
        'Agent 名称只能包含字母、数字、下划线和连字符，不能含空格或标点'
    }
  }
  if (name.toLowerCase() === RESERVED_NAME_ALL) {
    return { ok: false, reason: `Agent 名称不能使用保留词 "${name}"` }
  }
  return { ok: true }
}
