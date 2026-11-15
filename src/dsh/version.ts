/**
 * DeepSeek Harness version detection and compatibility gate.
 *
 * The plugin is built and tested against DSH 0.2.x. A different minor/major
 * version produces an explicit diagnostic error at load time (the Harness
 * reports it and keeps running without the plugin) instead of silently
 * registering against an API that may have changed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DshCompatibility {
  ok: boolean
  version: string | null
  testedRange: string
  reason: string
}

export const TESTED_DSH_RANGE = '>=0.2.0 <0.3.0'

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string
}

function parseVersion(input: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(input.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  }
}

/** Read the installed DSH version from the environment or the resolved package. */
export function detectDshVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = []
  if (env.DSH_INSTALL_DIR) candidates.push(join(env.DSH_INSTALL_DIR, 'package.json'))
  for (const candidate of candidates) {
    const version = readVersion(candidate)
    if (version) return version
  }
  return null
}

function readVersion(packageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/** Compare an installed version against the tested range. */
export function checkCompatibility(version: string | null): DshCompatibility {
  if (!version) {
    return {
      ok: true,
      version: null,
      testedRange: TESTED_DSH_RANGE,
      reason: 'DSH version could not be detected; continuing in fail-open mode.',
    }
  }
  const parsed = parseVersion(version)
  if (!parsed) {
    return {
      ok: true,
      version,
      testedRange: TESTED_DSH_RANGE,
      reason: `Unparseable DSH version "${version}"; continuing in fail-open mode.`,
    }
  }
  const inRange = parsed.major === 0 && parsed.minor === 2
  return {
    ok: inRange,
    version,
    testedRange: TESTED_DSH_RANGE,
    reason: inRange
      ? `DSH ${version} is within the tested range ${TESTED_DSH_RANGE}.`
      : `DSH ${version} is outside the tested range ${TESTED_DSH_RANGE}. Install a matching dsh-token-economizer release or upgrade the plugin.`,
  }
}
