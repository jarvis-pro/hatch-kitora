#!/usr/bin/env tsx
/**
 * RFC 0003 PR-3 — OpenAPI coverage cross-check.
 *
 * Walks `src/app/api/v1/**\/route.ts`, derives the (method, pathTemplate)
 * pairs each file exports, then compares against `openapi/v1.yaml`. Either
 * direction missing → exit 1 + a punch list.
 *
 * Run as part of CI:
 *   pnpm openapi:check
 *
 * What we DON'T check here (left to `redocly lint`):
 *   - schema validity
 *   - parameter types
 *   - example shape
 *   - dangling $refs
 *
 * The point of this script is to keep the path-set in sync. Anything else
 * is `redocly`'s job — they're better at it.
 */

import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { cwd, exit } from 'node:process';

import { glob } from 'node:fs/promises';
import yaml from 'js-yaml';

const ROOT = cwd();
const ROUTES_DIR = join(ROOT, 'src', 'app', 'api', 'v1');
const SPEC_PATH = join(ROOT, 'openapi', 'v1.yaml');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type Method = (typeof HTTP_METHODS)[number];

interface RouteEntry {
  /** OpenAPI-shaped path template, e.g. `/api/v1/orgs/{slug}/webhooks/{id}`. */
  path: string;
  method: Method;
  /** File path the entry was derived from, for error messages. */
  source: string;
}

async function listRouteFiles(): Promise<string[]> {
  const out: string[] = [];
  // Node's built-in glob (since 22) returns AsyncIterable<string>.
  for await (const entry of glob('**/route.ts', { cwd: ROUTES_DIR })) {
    out.push(entry);
  }
  return out;
}

/** Convert a `[slug]` segment in the file path to the OpenAPI-shaped `{slug}`. */
function dirToOpenApiPath(relPath: string): string {
  // Drop the trailing `route.ts`, normalize separators, replace bracket params.
  const segments = relPath.split(sep).filter((s) => s.length > 0);
  segments.pop(); // route.ts
  const transformed = segments.map((seg) => {
    if (seg.startsWith('[') && seg.endsWith(']')) {
      return `{${seg.slice(1, -1)}}`;
    }
    if (seg.startsWith('(') && seg.endsWith(')')) {
      // Route group — collapses, doesn't appear in URL.
      return null;
    }
    return seg;
  });
  const filtered = transformed.filter((s): s is string => s !== null);
  return `/api/v1${filtered.length > 0 ? '/' + filtered.join('/') : ''}`;
}

/**
 * Naive but durable: scan the file's text for `export async function METHOD`
 * and `export function METHOD` and `export const METHOD =`. Anything else is
 * not how Next.js App Router exposes a method handler anyway.
 */
function methodsFromSource(text: string): Method[] {
  const out: Method[] = [];
  for (const m of HTTP_METHODS) {
    const re = new RegExp(`export\\s+(async\\s+)?(?:function|const)\\s+${m}\\b`, 'm');
    if (re.test(text)) out.push(m);
  }
  return out;
}

async function discoverRoutes(): Promise<RouteEntry[]> {
  const files = await listRouteFiles();
  const out: RouteEntry[] = [];
  for (const f of files) {
    const abs = join(ROUTES_DIR, f);
    const text = readFileSync(abs, 'utf8');
    const methods = methodsFromSource(text);
    if (methods.length === 0) {
      console.warn(`[openapi-check] ⚠ ${relative(ROOT, abs)} declares no recognized HTTP exports`);
      continue;
    }
    const path = dirToOpenApiPath(f);
    for (const method of methods) {
      out.push({ path, method, source: relative(ROOT, abs) });
    }
  }
  return out;
}

interface SpecPathItem {
  [method: string]: unknown;
}

function loadSpecRoutes(): RouteEntry[] {
  const text = readFileSync(SPEC_PATH, 'utf8');
  const doc = yaml.load(text) as { paths?: Record<string, SpecPathItem> } | null;
  if (!doc || typeof doc !== 'object' || !doc.paths) {
    throw new Error(`openapi/v1.yaml has no \`paths:\` block`);
  }
  const out: RouteEntry[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const key of Object.keys(item)) {
      const upper = key.toUpperCase() as Method;
      if ((HTTP_METHODS as readonly string[]).includes(upper)) {
        out.push({ path, method: upper, source: 'openapi/v1.yaml' });
      }
    }
  }
  return out;
}

function entryKey(e: { path: string; method: Method }): string {
  return `${e.method} ${e.path}`;
}

async function main() {
  const [routeEntries, specEntries] = await Promise.all([
    discoverRoutes(),
    Promise.resolve(loadSpecRoutes()),
  ]);

  const routeKeys = new Set(routeEntries.map(entryKey));
  const specKeys = new Set(specEntries.map(entryKey));

  const missingFromSpec = [...routeKeys].filter((k) => !specKeys.has(k)).sort();
  const missingFromCode = [...specKeys].filter((k) => !routeKeys.has(k)).sort();

  if (missingFromSpec.length === 0 && missingFromCode.length === 0) {
    console.log(`[openapi-check] ✓ ${routeKeys.size} route(s) match openapi/v1.yaml exactly.`);
    return;
  }

  if (missingFromSpec.length > 0) {
    console.error('\n[openapi-check] ✗ Routes implemented in code but missing from spec:');
    for (const k of missingFromSpec) console.error('   - ' + k);
  }
  if (missingFromCode.length > 0) {
    console.error('\n[openapi-check] ✗ Spec paths with no matching route handler:');
    for (const k of missingFromCode) console.error('   - ' + k);
  }
  console.error('\nFix by editing `openapi/v1.yaml` (and/or the route file) so both sides agree.');
  exit(1);
}

main().catch((err) => {
  console.error('[openapi-check] fatal:', err);
  exit(1);
});
