// RFC 0005 — Multi-region runtime entrypoint.
//
// `currentRegion()` is the *only* sanctioned reader of the deploy region.
// Resolution rules:
//
//   1. `KITORA_REGION` — the canonical, uppercase env var that lines up
//      with the Prisma `Region` enum.
//   2. legacy `REGION` (`'global' | 'cn'`) — accepted for one deprecation
//      window (v0.6 + v0.7); a one-shot `logger.warn` fires the first
//      time we fall back to it.
//   3. neither set — default to `GLOBAL`. This is intentionally lenient
//      for `pnpm dev` / unit tests; production deploys set the var via
//      Dockerfile + compose (see `docs/deploy/global.md`).
//
// We avoid `'server-only'` here even though every consumer is server-side:
// Playwright e2e fixtures import `currentRegion()` transitively (through
// `recordAudit` and `provisionSsoUser`) and the test runner is Node, not
// the Next bundler. The transitive `@/lib/db` deps still keep the module
// out of any client bundle in practice.

import { Region } from '@prisma/client';

import { env } from '@/env';
import { logger } from '@/lib/logger';

/**
 * Map from the legacy lower-case `REGION` env var to the new `Region`
 * enum. Kept tight — only the values v0.5 actually shipped are accepted.
 */
const LEGACY_REGION_MAP = {
  global: Region.GLOBAL,
  cn: Region.CN,
} as const satisfies Record<string, Region>;

let legacyWarningEmitted = false;

function emitLegacyWarning(value: string): void {
  if (legacyWarningEmitted) return;
  legacyWarningEmitted = true;
  logger.warn(
    {
      legacyValue: value,
      replacement: 'KITORA_REGION',
      removalIn: 'v0.8',
    },
    'env-REGION-deprecated',
  );
}

/**
 * The region this process serves. Determined at first call from
 * `KITORA_REGION` (preferred) or the legacy `REGION` (deprecated). The
 * result is cached: regions can never change while a process is running.
 */
let cached: Region | null = null;

export function currentRegion(): Region {
  if (cached !== null) return cached;

  const fromCanonical = env.KITORA_REGION;
  if (fromCanonical) {
    cached = fromCanonical;
    return cached;
  }

  const legacy = env.REGION;
  if (legacy) {
    emitLegacyWarning(legacy);
    cached = LEGACY_REGION_MAP[legacy];
    return cached;
  }

  cached = Region.GLOBAL;
  return cached;
}

/** Convenience predicate — true iff this process serves the CN region. */
export function isCnRegion(): boolean {
  return currentRegion() === Region.CN;
}

/**
 * Test-only helper: forget the cached region so a subsequent call
 * re-reads the environment. Production code must never call this — the
 * region is supposed to be immutable for the life of the process.
 *
 * @internal
 */
export function __resetRegionCacheForTests(): void {
  cached = null;
  legacyWarningEmitted = false;
}
