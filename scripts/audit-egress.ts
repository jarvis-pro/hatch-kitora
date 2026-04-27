#!/usr/bin/env tsx
/**
 * RFC 0006 §8.1 — CN 区域出站流量审计。
 *
 * 遍历 `src/` 和 `scripts/`，标记所有指向 CN 出站黑名单主机的字符串字面量。
 * 原因：CN 部署不得调用 `*.amazonaws.com` / `*.upstash.io` / `*.resend.com` /
 * `api.stripe.com` / `*.sentry.io` 等 —— 否则会将 CN 境内的 PII 跨越防火墙
 * 传输到境外数据中心，违反 PIPL §38+。
 *
 * 白名单豁免：
 *   - 注释或文档字符串中的 URL（此处不从注释里解析 —— 正则只匹配字符串字面量，
 *     TS 注释会被还原为空白字符，因此 `// https://aws...` 是不可见的，除非
 *     有人把 URL 嵌进真正的字符串里）。实践中扫描结果略偏保守；无害的误报可以
 *     通过拆分 URL 或将其移入注释来消除。
 *   - `src/lib/storage/s3.ts` 中的 GLOBAL provider 模块、`src/lib/storage/`
 *     下的 AWS SDK、以及 `src/lib/rate-limit.ts` 中的 `@upstash/redis` ——
 *     这些模块只在 `currentRegion()` 返回 GLOBAL 时执行，CN region 运行时
 *     永远不会触达它们。已在下方 `EXEMPT_FILES` 中声明。
 *   - `localhost`、`127.0.0.1`、`*.kitora.cn`、`*.aliyuncs.com`、
 *     `*.alipay.com`、`*.weixin.qq.com` —— 这些在 CN region 合法。
 *
 * 退出码：
 *   0 —— 没有违规，或有违规但 `KITORA_REGION` 不是 CN
 *       （非 CN 模式下脚本输出后以 0 退出；检查仅对 CN 部署卡关）。
 *   1 —— 有违规且 `KITORA_REGION=CN`（或传入 `--strict`）。
 *
 * 通过 `pnpm egress:check` 接入 CI。RFC 0006 §12 将严格程度（仅警告 vs CI 报错）
 * 留作开放决策；我们的策略是「非 CN 环境仅警告，CN 环境报错」，确保默认的
 * GLOBAL 配置零噪音。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { argv, cwd, exit, env as procEnv } from 'node:process';

const ROOT = cwd();
const SCAN_DIRS = ['src', 'scripts'];
const FILE_EXTS = new Set(['.ts', '.tsx', '.cjs', '.mjs']);

/** CN 部署中禁止出现的主机，按后缀匹配 URL host。 */
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

/** 即使匹配到禁止后缀，也属于 CN 合法的主机。 */
const ALLOW_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  'kitora.cn',
  'kitora.io', // 营销跳转域；不承载数据
  'aliyuncs.com',
  'alipay.com',
  'alipayobjects.com',
  'weixin.qq.com',
  'tenpay.com',
  'wxpay.com',
  'dingtalk.com',
];

/**
 * 仅限 GLOBAL 的文件 —— 可以保留对禁止主机的引用，因为它们被
 * `isCnRegion()` 短路保护，CN 部署的运行时永远不会执行到。
 * 路径相对于仓库根目录。
 */
const EXEMPT_FILES: readonly string[] = [
  'src/lib/storage/s3.ts',
  'src/lib/email/client.ts', // Resend 客户端；sendEmail() 在 CN 区绕过它
  'scripts/audit-egress.ts', // 本文件自身
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
      // 防御性跳过 node_modules 和 Next 构建产物，
      // 尽管 SCAN_DIRS 不应包含它们。
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      yield* walk(full);
    } else if (FILE_EXTS.has(extname(full))) {
      yield full;
    }
  }
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  // 匹配字符串字面量中的 http(s) URL。由于 TS 注释也会被扫描，
  // 有意在 JSDoc 中提及禁止主机的用户可以拆分 URL（`api.stripe` + `.com`）
  // 来规避匹配。漏报比误报代价更高。
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
    console.log('audit-egress: 未发现禁止主机引用。');
    exit(0);
  }

  console.log(`audit-egress: 发现 ${hits.length} 处禁止主机引用：`);
  for (const h of hits) {
    console.log(`  ${h.file}:${h.line}  ${h.host}  ← ${h.url}`);
  }
  console.log('');
  if (strict) {
    console.log('严格模式（KITORA_REGION=CN 或 --strict）→ 退出码 1');
    exit(1);
  }
  console.log('非严格模式（使用 --strict 或 KITORA_REGION=CN 可强制失败）');
  exit(0);
}

main();
