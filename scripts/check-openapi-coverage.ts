#!/usr/bin/env tsx
/**
 * RFC 0003 PR-3 — OpenAPI 覆盖率交叉检查。
 *
 * 遍历 `src/app/api/v1/**\/route.ts`，推导每个文件导出的 (method, pathTemplate)
 * 对，再与 `openapi/v1.yaml` 进行比较。任意方向缺失 → exit 1 并输出差异清单。
 *
 * 作为 CI 的一部分运行：
 *   pnpm openapi:check
 *
 * 不在此检查（交给 `redocly lint`）：
 *   - schema 有效性
 *   - 参数类型
 *   - 示例格式
 *   - 悬空 $ref
 *
 * 本脚本的职责是保持 path 集合同步。其余工作由 `redocly` 负责 —— 它更擅长。
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
  /** OpenAPI 格式的路径模板，例如 `/api/v1/orgs/{slug}/webhooks/{id}`。 */
  path: string;
  method: Method;
  /** 推导此条目的文件路径，用于错误信息。 */
  source: string;
}

async function listRouteFiles(): Promise<string[]> {
  const out: string[] = [];
  // Node 22 内置 glob，返回 AsyncIterable<string>。
  for await (const entry of glob('**/route.ts', { cwd: ROUTES_DIR })) {
    out.push(entry);
  }
  return out;
}

/** 将文件路径中的 `[slug]` 段转换为 OpenAPI 格式的 `{slug}`。 */
function dirToOpenApiPath(relPath: string): string {
  // 去掉末尾的 `route.ts`，统一分隔符，替换括号参数。
  const segments = relPath.split(sep).filter((s) => s.length > 0);
  segments.pop(); // route.ts
  const transformed = segments.map((seg) => {
    if (seg.startsWith('[') && seg.endsWith(']')) {
      return `{${seg.slice(1, -1)}}`;
    }
    if (seg.startsWith('(') && seg.endsWith(')')) {
      // 路由组 —— 折叠，不出现在 URL 中。
      return null;
    }
    return seg;
  });
  const filtered = transformed.filter((s): s is string => s !== null);
  return `/api/v1${filtered.length > 0 ? '/' + filtered.join('/') : ''}`;
}

/**
 * 简单但健壮：扫描文件文本，查找 `export async function METHOD`、
 * `export function METHOD` 和 `export const METHOD =`。
 * Next.js App Router 暴露方法处理器只会用这几种形式。
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
      console.warn(`[openapi-check] ⚠ ${relative(ROOT, abs)} 未声明任何已知的 HTTP 导出`);
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
    throw new Error(`openapi/v1.yaml 缺少 \`paths:\` 块`);
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
    console.log(`[openapi-check] ✓ ${routeKeys.size} 条路由与 openapi/v1.yaml 完全匹配。`);
    return;
  }

  if (missingFromSpec.length > 0) {
    console.error('\n[openapi-check] ✗ 代码中已实现但规范中缺失的路由：');
    for (const k of missingFromSpec) console.error('   - ' + k);
  }
  if (missingFromCode.length > 0) {
    console.error('\n[openapi-check] ✗ 规范中存在但没有对应路由处理器的路径：');
    for (const k of missingFromCode) console.error('   - ' + k);
  }
  console.error('\n请编辑 `openapi/v1.yaml`（和/或路由文件），使两侧保持一致。');
  exit(1);
}

main().catch((err) => {
  console.error('[openapi-check] 致命错误：', err);
  exit(1);
});
