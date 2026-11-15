export const DEFAULT_REDACTION = { redactSecrets: true, maxTextBytes: 4_000 };
const SECRET_KEY = /(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|private[_-]?key|access[_-]?key|credential|auth[_-]?token|bearer|session[_-]?key|client[_-]?secret)/i;
const PATTERNS = [
    { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED PRIVATE KEY]' },
    { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: '[REDACTED GITHUB TOKEN]' },
    { name: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED AWS KEY]' },
    { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '[REDACTED JWT]' },
    { name: 'sk-key', re: /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED API KEY]' },
    { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: 'Bearer [REDACTED]' },
    { name: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replacement: '$1[REDACTED]@' },
    { name: 'env-assignment', re: /\b([A-Za-z_][A-Za-z0-9_.-]{0,64})\s*[:=]\s*(["']?)[^\s"']{8,}\2/g, replacement: '$1=[REDACTED]', filter: (groups) => SECRET_KEY.test(groups[1] ?? '') },
    { name: 'cli-flag', re: /(--?(?:api[_-]?key|token|password|secret|access[_-]?key)[=\s]+)([^\s"']{6,})/gi, replacement: '$1[REDACTED]' },
    { name: 'anthropic-openai-key', re: /\b(?:sk-ant-[A-Za-z0-9_-]{10,}|deepseek-[A-Za-z0-9_-]{16,})\b/g, replacement: '[REDACTED API KEY]' },
];
/** True for a path whose contents are never stored or forwarded. */
export function isSensitivePath(path) {
    const normalized = path.replace(/\\/g, '/').toLowerCase();
    return /(^|\/)(\.env(\.[^/]+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_rsa|id_ed25519|id_ecdsa|\.aws\/credentials|\.config\/gcloud\/credentials\.db|credentials\.json|secrets?\.(json|ya?ml|toml))$/.test(normalized)
        || /\.(pem|key|p12|pfx|keystore)$/.test(normalized);
}
/**
 * Redact secrets in a text. The `filter` escape hatch keeps patterns that
 * match ordinary assignments (e.g. `PATH=...`) from over-redacting.
 */
export function redactSecrets(text) {
    let result = text;
    for (const pattern of PATTERNS) {
        result = result.replace(pattern.re, (...match) => {
            const groups = match;
            if (pattern.filter && !pattern.filter(groups))
                return groups[0] ?? '';
            const replacement = pattern.replacement;
            if (!replacement.includes('$'))
                return replacement;
            return replacement.replace(/\$(\d)/g, (_, index) => groups[Number(index)] ?? '');
        });
    }
    return result;
}
/** Remove control characters that would corrupt logs or JSONL framing. */
export function stripControlCharacters(text) {
    // Keep tab and newline so multi-line evidence remains readable.
    return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}
/** Redact, strip controls, and truncate to a byte budget on a character boundary. */
export function sanitizeText(text, policy = DEFAULT_REDACTION) {
    const redacted = policy.redactSecrets ? redactSecrets(String(text ?? '')) : String(text ?? '');
    const clean = stripControlCharacters(redacted);
    if (Buffer.byteLength(clean, 'utf8') <= policy.maxTextBytes)
        return clean;
    let end = Math.min(clean.length, policy.maxTextBytes);
    while (end > 0 && Buffer.byteLength(clean.slice(0, end), 'utf8') > policy.maxTextBytes)
        end -= 1;
    return `${clean.slice(0, end)}\n…[truncated]`;
}
/** Mask a free-form value for display in the UI. */
export function maskValue(value) {
    if (value.length <= 4)
        return '****';
    return `${value.slice(0, 2)}****${value.slice(-2)}`;
}
