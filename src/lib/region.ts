// RFC 0005 — 多区域运行时入口点。
//
// `currentRegion()` 是部署区域的*唯一*批准读取器。
// 解析规则：
//
//   1. `KITORA_REGION` — 规范、大写的环境变量与 Prisma `Region`
//      枚举对齐。
//   2. 遗留 `REGION`（`'global' | 'cn'`） — 接受一个弃用
//      窗口（v0.6 + v0.7）；一次 `logger.warn` 首次
//      回退到它时触发。
//   3. 都未设置 — 默认为 `GLOBAL`。这对于
//      `pnpm dev` / 单元测试是有意宽松的；生产部署通过
//      Dockerfile + compose 设置变量（见 `docs/deploy/global.md`）。
//
// 我们即使每个使费者都是 server-side 也避免了 'server-only' —
// Playwright e2e fixtures 可传递导入 `currentRegion()`（通过
// `recordAudit` 和 `provisionSsoUser`）并且测试运行器是 Node，不是
// Next 打包程序。可传递 `@/lib/db` deps 仍然把模块
// 保留在实际上任何客户端包之外。

import { Region } from '@prisma/client';

import { env } from '@/env';
import { logger } from '@/lib/logger';

/**
 * 从遗留小写 `REGION` 环境变量到新 `Region`
 * 枚举的映射。保持紧凑 — 仅接受 v0.5 实际运送的值。
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
 * 此进程服务的区域。在首次调用时从
 * `KITORA_REGION`（首选）或遗留 `REGION`（已弃用）确定。结果
 * 被缓存：区域在进程运行时永远无法更改。
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

/** 便利谓词 — 当且仅当此进程服务 CN 区域时为真。 */
export function isCnRegion(): boolean {
  return currentRegion() === Region.CN;
}

/**
 * 仅供测试的助手：忘记缓存的区域以便后续调用
 * 重新读取环境。生产代码绝不能调用这个 — 区域
 * 应该对进程的生命周期不可变。
 *
 * @internal
 */
export function __resetRegionCacheForTests(): void {
  cached = null;
  legacyWarningEmitted = false;
}
