#!/usr/bin/env node
/**
 * Verify committed distribution artifacts against a fresh build.
 *
 * `lib/` is emitted by `tsc`; this script compiles the current `src/` into a temporary
 * directory and compares every `.js` file byte for byte, so a stale commit cannot ship.
 * `client/index.js` has no build step (plain JavaScript loaded by the Harness module
 * loader); it is syntax-checked and its package exports are verified instead of diffed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const LIB = join(ROOT, 'lib')
const CLIENT = join(ROOT, 'client', 'index.js')

function walk(dir, base = dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path, base))
    else out.push(relative(base, path))
  }
  return out.sort()
}

function fail(message) {
  console.error(`check:dist: ${message}`)
  process.exitCode = 1
}

if (!existsSync(TSC)) {
  fail('typescript is not installed; run npm install first')
  process.exit()
}
if (!existsSync(CLIENT)) fail('client/index.js is missing')
if (!existsSync(join(ROOT, 'cordis.patch.yml'))) fail('cordis.patch.yml is missing')

const tmp = mkdtempSync(join(tmpdir(), 'te-dist-'))
try {
  execFileSync(process.execPath, [TSC, '-p', join(ROOT, 'tsconfig.json'), '--outDir', tmp], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  const built = walk(tmp).filter((file) => file.endsWith('.js'))
  const shipped = walk(LIB).filter((file) => file.endsWith('.js'))
  const builtSet = new Set(built)
  const shippedSet = new Set(shipped)
  for (const file of built) {
    if (!shippedSet.has(file)) {
      fail(`lib/${file} is missing from the committed build`)
      continue
    }
    const expected = readFileSync(join(tmp, file))
    const actual = readFileSync(join(LIB, file))
    if (!expected.equals(actual)) fail(`lib/${file} is stale; run npm run build`)
  }
  for (const file of shipped) {
    if (!builtSet.has(file)) fail(`lib/${file} has no source; remove it or rebuild`)
  }

  // The client is source-only; prove it parses and is what package.json exports.
  if (existsSync(CLIENT)) {
    execFileSync(process.execPath, ['--check', CLIENT], { stdio: 'inherit' })
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    if (pkg.exports?.['./client'] !== './client/index.js') fail('package.json exports["./client"] must point at client/index.js')
    if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('package.json dsh.bundle.patch must point at cordis.patch.yml')
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (process.exitCode) process.exit(process.exitCode)
console.log(`check:dist: lib/ matches a fresh build (${walk(LIB).filter((f) => f.endsWith('.js')).length} files); client/ syntax and bundle manifest OK`)
