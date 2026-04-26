#!/usr/bin/env tsx
/**
 * RFC 0006 §8.1 — outbound-traffic audit for the CN region.
 *
 * Walks `src/` + `scripts/` and flags any string literal that points at
 * a host on the CN egress black-list. The rationale: a CN deploy must
 * not call `*.amazonaws.com` / `*.upstash.io` / `*.resend.com` /
 * `api.stripe.com` / `*.sentry.io` etc. — that would push CN-resident
 * PII over the GFW into a foreign data centre, violating PIPL §38+.
 *
 * Allowlist exemptions:
 *   - URLs in comments or doc strings (we don't parse them out of comments
 *     here — the regex only matches inside string literals, but comments
 *     in TS get stripped to whitespace so `// https://aws...` is invisible
 *     unless someone embeds the URL in a real string).  In practice the
 *     scan errs slightly conservative; harmless flags can be silenced by
 *     splitting the URL or moving it into a comment.
 *   - GLOBAL provider modules under `src/lib/storage/s3.ts`, the AWS SDK
 *     in `src/lib/storage/`, and `@upstash/redis` in `src/lib/rate-limit.ts`
 *     — these only run when `currentRegion()` returns GLOBAL and the
 *     CN-region runtime never reaches them.  They're declared in
 *     `EXEMPT_FILES` below.
 *   - `localhost`, `127.0.0.1`, `*.kitora.cn`, `*.aliyuncs.com`,
 *     `*.alipay.com`, `*.weixin.qq.com` — these are CN-region-legitimate.
 *
 * Exit code:
 *   0 — no violations, OR violations exist but `KITORA_REGION` is not CN
 *       (in non-CN mode the script reports + exits 0; the check is only
 *       gating for CN deploys).
 *   1 — violations exist AND `KITORA_REGION=CN` (or `--strict`).
 *
 * Wire into CI as `pnpm egress:check`. RFC 0006 §12 left the strictness
 * level (warn-only vs CI-fail) as an open decision; we ship as
 * "warn outside CN, fail inside CN" so the zero-config GLOBAL case stays
 * green.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { argv, cwd, exit, env as procEnv } from 'node:process';

const ROOT = cwd();
const SCAN_DIRS = ['src', 'scripts'];
const FILE_EXTS = new Set(['.ts', '.tsx', '.cjs', '.mjs']);

/** Hosts forbidden under CN deploy. Suffix-matched against the URL host. */
const FORBIDDEN_HOSTS: readonly string[] = [
  'amazonaws.com',
  'upstash.io',
  'resend.com',
  'api.stripe.com',
  'sentry.io',
  'github.com',
  'githubusercontent.com',
  'googleapis.com',
  'googleusercontent.com',
];

/** Hosts that are CN-legal even when a forbidden suffix would otherwise match. */
const ALLOW_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  'kitora.cn',
  'kitora.io', // marketing redirect; not data-bearing
  'aliyuncs.com',
  'alipay.com',
  'alipayobjects.com',
  'weixin.qq.com',
  'tenpay.com',
  'wxpay.com',
  'dingtalk.com',
];

/**
 * Files that are GLOBAL-only — safe to keep references to forbidden hosts
 * because they're gated by `isCnRegion()` short-circuits and never run on
 * a CN deploy. List relative to the repo root.
 */
const EXEMPT_FILES: readonly string[] = [
  'src/lib/storage/s3.ts',
  'src/lib/email/client.ts', // Resend client; sendEmail() routes around it on CN
  'scripts/audit-egress.ts', // this file
];

interface Hit {
  file: string;
  line: number;
  url: string;
  host: string;
}

function isExempt(relPath: string): boolean {
  return EXEMPT_FILES.some((p) => relPath === p || relPath.endsWith('/' + p));
}

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchesSuffix(host: string, list: readonly string[]): boolean {
  return list.some((suffix) => host === suffix || host.endsWith('.' + suffix));
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip `node_modules` and Next build artefacts defensively even
      // though SCAN_DIRS shouldn't contain them.
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      yield* walk(full);
    } else if (FILE_EXTS.has(extname(full))) {
      yield full;
    }
  }
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  // Match http(s) URLs inside string literals. We match anywhere in the
  // file because TS comments get scanned too; users who intentionally
  // mention a forbidden host in a JSDoc can split it (`api.stripe` +
  // `.com`) to dodge the match. False positives are cheaper than false
  // negatives here.
  const URL_RE = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s"'`]*)?/g;

  for (const dir of SCAN_DIRS) {
    const root = join(ROOT, dir);
    try {
      statSync(root);
    } catch {
      continue;
    }

    for (const file of walk(root)) {
      const rel = relative(ROOT, file);
      if (isExempt(rel)) continue;

      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((lineText, i) => {
        for (const match of lineText.matchAll(URL_RE)) {
          const url = match[0];
          const host = hostFromUrl(url);
          if (!host) continue;
          if (matchesSuffix(host, ALLOW_HOSTS)) continue;
          if (matchesSuffix(host, FORBIDDEN_HOSTS)) {
            hits.push({ file: rel, line: i + 1, url, host });
          }
        }
      });
    }
  }
  return hits;
}

function main() {
  const strict = argv.includes('--strict') || procEnv.KITORA_REGION === 'CN';
  const hits = scan();

  if (hits.length === 0) {
    console.log('audit-egress: no forbidden-host references found.');
    exit(0);
  }

  console.log(`audit-egress: ${hits.length} forbidden-host reference(s):`);
  for (const h of hits) {
    console.log(`  ${h.file}:${h.line}  ${h.host}  ← ${h.url}`);
  }
  console.log('');
  if (strict) {
    console.log('strict mode (KITORA_REGION=CN or --strict) → exit 1');
    exit(1);
  }
  console.log('non-strict mode (run with --strict or KITORA_REGION=CN to fail)');
  exit(0);
}

main();
