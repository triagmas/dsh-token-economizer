import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_REDACTION,
  isSensitivePath,
  maskValue,
  redactSecrets,
  sanitizeText,
  stripControlCharacters,
} from '../lib/core/redact.js'

test('known credential shapes are redacted', () => {
  const cases = [
    ['github', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', /ghp_/],
    ['github-pat', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop', /github_pat_/],
    ['aws', 'AKIAIOSFODNN7EXAMPLE', /AKIAIOSFODNN7EXAMPLE/],
    ['sk', 'sk-proj-abcdefghijklmnopqrstuv', /sk-proj-/],
    ['bearer', 'Authorization: Bearer abcdefghijklmnop.qrstuvwx', /abcdefghijklmnop/],
    ['url', 'https://user:hunter2pass@example.test/repo.git', /hunter2pass/],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', /eyJhbGci/],
  ]
  for (const [name, input, leaked] of cases) {
    const output = redactSecrets(input)
    assert.doesNotMatch(output, leaked, `${name} must not leak`)
    assert.match(output, /REDACTED/, `${name} must carry a marker`)
  }
})

test('secret-looking assignments are redacted while ordinary variables survive', () => {
  assert.match(redactSecrets('API_KEY=abcdef123456'), /\[REDACTED\]/)
  assert.match(redactSecrets('MY_SECRET: "abcdef123456"'), /\[REDACTED\]/)
  assert.doesNotMatch(redactSecrets('PATH=/usr/local/bin:/usr/bin'), /REDACTED/)
  assert.doesNotMatch(redactSecrets('NODE_ENV=production'), /REDACTED/)
})

test('private key blocks are removed entirely', () => {
  const text = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\nafter'
  const output = redactSecrets(text)
  assert.doesNotMatch(output, /MIIEow/)
  assert.match(output, /\[REDACTED PRIVATE KEY\]/)
})

test('sensitive paths are never eligible for evidence capture', () => {
  for (const path of ['.env', '.env.local', 'config/.npmrc', 'certs/server.pem', 'keys/id_rsa', '.git-credentials', 'secrets.json']) {
    assert.equal(isSensitivePath(path), true, path)
  }
  for (const path of ['src/index.ts', 'README.md', 'docs/security.md', 'package.json']) {
    assert.equal(isSensitivePath(path), false, path)
  }
})

test('sanitize bounds bytes, strips controls and keeps tabs and newlines', () => {
  const text = `a\u0000b\u0007c\td\ne${'x'.repeat(10_000)}`
  const output = sanitizeText(text, { ...DEFAULT_REDACTION, maxTextBytes: 100 })
  assert.ok(Buffer.byteLength(output, 'utf8') <= 140, 'bounded text plus the truncation marker')
  assert.doesNotMatch(output, /[\u0000\u0007]/)
  assert.match(output, /\t/)
  assert.match(output, /\n/)
})

test('sanitize is idempotent on already-clean text', () => {
  const text = 'npm test passed in 3.2s'
  assert.equal(stripControlCharacters(text), text)
  assert.equal(sanitizeText(text), text)
})

test('maskValue keeps only a short prefix and suffix', () => {
  const masked = maskValue('sk-abcdefghijklmnopqrstuvwxyz')
  assert.match(masked, /^sk\*\*\*\*/)
  assert.match(masked, /yz$/)
  assert.doesNotMatch(masked, /defghijklm/)
})
