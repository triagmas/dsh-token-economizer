/**
 * Tool-name allowlist matching.
 *
 * Upstream protects a tool by exact name or by an `fnmatch` pattern such as
 * `mcp__headroom__*`. Tool names are not paths: `*` matches any run of characters
 * (including `__`) and `**` is accepted as the same wildcard, so a pattern behaves the
 * way a person writes it. `?` matches one character. A pattern without `*` or `?` is
 * compared exactly, so names containing brackets or backslashes stay literal.
 */

/** True when `name` matches `pattern`; an empty pattern matches nothing. */
export function globMatches(pattern: string, name: string): boolean {
  const source = String(pattern ?? '').trim()
  if (!source || !name) return false
  if (source === name) return true
  if (!/[*?]/.test(source)) return false
  let regex = '^'
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string
    if (char === '*') {
      while (source[i + 1] === '*') i += 1
      regex += '.*'
    } else if (char === '?') {
      regex += '.'
    } else {
      regex += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    }
  }
  regex += '$'
  return new RegExp(regex).test(name)
}

/** True when any configured pattern matches the name (exact names included). */
export function allowlistMatches(name: string, allowlist: Iterable<string> | undefined | null): boolean {
  if (!allowlist) return false
  for (const pattern of allowlist) {
    if (typeof pattern === 'string' && globMatches(pattern, name)) return true
  }
  return false
}
