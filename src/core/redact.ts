/**
 * Secret redaction and text minimization.
 *
 * Learned knowledge and metrics are untrusted data. Before anything is written
 * to disk or sent to a judge model it passes through here: credentials are
 * masked, control characters removed, and length bounded.
 */
import type { RedactionPolicy } from './types.js'

export const DEFAULT_REDACTION: RedactionPolicy = { redactSecrets: true, maxTextBytes: 4_000 }

/** Redaction is best-effort and must stay bounded even for a pathological transcript tail. */
export const MAX_REDACTION_BYTES = 256 * 1024

const SECRET_KEY = /(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|private[_-]?key|access[_-]?key|credential|auth[_-]?token|bearer|session[_-]?key|client[_-]?secret)/i

type RedactionPattern = { name: string; re: RegExp; replacement: string; filter?: (groups: Array<string | undefined>) => boolean }

const PATTERNS: RedactionPattern[] = [
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: '[REDACTED GITHUB TOKEN]' },
  { name: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED AWS KEY]' },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '[REDACTED JWT]' },
  { name: 'authorization-header', re: /\bAuthorization\s*:\s*(Basic|Token|Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, replacement: 'Authorization: $1 [REDACTED]' },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED SLACK TOKEN]' },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: '[REDACTED GOOGLE API KEY]' },
  { name: 'stripe-live-key', re: /\b(?:sk|rk|pk)_live_[0-9A-Za-z]{16,}\b/g, replacement: '[REDACTED STRIPE KEY]' },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g, replacement: '[REDACTED NPM TOKEN]' },
  { name: 'sk-key', re: /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED API KEY]' },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: 'Bearer [REDACTED]' },
  { name: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replacement: '$1[REDACTED]@' },
  { name: 'json-secret', re: /"([^"\r\n]{1,64})"\s*:\s*"([^"\r\n]{6,})"/g, replacement: '"$1": "[REDACTED]"', filter: (groups) => SECRET_KEY.test(groups[1] ?? '') },
  { name: 'env-assignment', re: /\b([A-Za-z_][A-Za-z0-9_.-]{0,64})\s*[:=]\s*(["']?)[^\s"']{6,}\2/g, replacement: '$1=[REDACTED]', filter: (groups) => SECRET_KEY.test(groups[1] ?? '') },
  { name: 'cli-flag', re: /(--?(?:api[_-]?key|token|password|secret|access[_-]?key)[=\s]+)([^\s"']{6,})/gi, replacement: '$1[REDACTED]' },
  { name: 'anthropic-openai-key', re: /\b(?:sk-ant-[A-Za-z0-9_-]{10,}|deepseek-[A-Za-z0-9_-]{16,})\b/g, replacement: '[REDACTED API KEY]' },
]

/** True for a path whose contents are never stored or forwarded. */
export function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  return /(^|\/)(\.env(\.[^/]+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_rsa|id_ed25519|id_ecdsa|\.aws\/credentials|\.config\/gcloud\/credentials\.db|credentials\.json|secrets?\.(json|ya?ml|toml))$/.test(normalized)
    || /\.(pem|key|p12|pfx|keystore)$/.test(normalized)
}

/**
 * Redact secrets in a text. The `filter` escape hatch keeps patterns that
 * match ordinary assignments (e.g. `PATH=...`) from over-redacting.
 */
/**
 * A private-key block is scanned by delimiter rather than by a lazy `[\s\S]*?` regex:
 * an unterminated block would otherwise make the engine retry across the whole input.
 * A BEGIN without a matching END redacts from that BEGIN to the end of the text.
 */
function redactPrivateKeyBlocks(text: string): string {
  const beginRe = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
  const endRe = /-----END [A-Z ]*PRIVATE KEY-----/g
  let out = ''
  let cursor = 0
  for (;;) {
    beginRe.lastIndex = cursor
    const begin = beginRe.exec(text)
    if (!begin) break
    endRe.lastIndex = begin.index + begin[0].length
    const end = endRe.exec(text)
    out += `${text.slice(cursor, begin.index)}[REDACTED PRIVATE KEY]`
    if (!end) {
      cursor = text.length
      break
    }
    cursor = end.index + end[0].length
  }
  return out + text.slice(cursor)
}

/** Cut text to a UTF-8 byte budget without splitting the final character. */
function capToBytes(text: string, maxBytes: number): string {
  if (text.length <= maxBytes && Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const buf = Buffer.from(text.slice(0, maxBytes), 'utf8')
  let end = Math.min(buf.length, maxBytes)
  while (end > 0 && end < buf.length && (buf[end] & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

/** Cut an oversized input on a character boundary before any regex runs. */
function capForRedaction(text: string): string {
  return capToBytes(text, MAX_REDACTION_BYTES)
}

/** Redact secrets in a text. The `filter` escape hatch keeps patterns that
 * match ordinary assignments (e.g. `PATH=...`) from over-redacting.
 */
export function redactSecrets(text: string): string {
  let result = redactPrivateKeyBlocks(capForRedaction(String(text ?? '')))
  for (const pattern of PATTERNS) {
    result = result.replace(pattern.re, (...match: unknown[]) => {
      const groups = match as Array<string | undefined>
      if (pattern.filter && !pattern.filter(groups)) return groups[0] ?? ''
      const replacement = pattern.replacement
      if (!replacement.includes('$')) return replacement
      return replacement.replace(/\$(\d)/g, (_, index: string) => groups[Number(index)] ?? '')
    })
  }
  return result
}

/** Remove control characters that would corrupt logs or JSONL framing. */
export function stripControlCharacters(text: string): string {
  // Keep tab and newline so multi-line evidence remains readable.
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

/** Redact, strip controls, and truncate to a byte budget on a character boundary. */
export function sanitizeText(text: string, policy: RedactionPolicy = DEFAULT_REDACTION): string {
  const raw = capForRedaction(String(text ?? ''))
  const redacted = policy.redactSecrets ? redactSecrets(raw) : raw
  const clean = stripControlCharacters(redacted)
  if (Buffer.byteLength(clean, 'utf8') <= policy.maxTextBytes) return clean
  return `${capToBytes(clean, policy.maxTextBytes)}\n…[truncated]`
}

/** Mask a free-form value for display in the UI. */
export function maskValue(value: string): string {
  if (value.length <= 4) return '****'
  return `${value.slice(0, 2)}****${value.slice(-2)}`
}
