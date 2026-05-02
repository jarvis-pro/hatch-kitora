// RFC 0005 — 多区域运行时入口点。
//
// `currentRegion()` 是部署区域的*唯一*批准读取器。解析规则封装在零依赖纯函数
// `parseRegion()`（`src/lib/region-parse.ts`），edge runtime 的 middleware 直接
// import 同一份纯函数，避免双轨实现漂移。本文件在纯函数之外多承担三件事：
//
//   1. 回填到 Prisma `Region` enum 类型（让上层 ORM 调用类型对齐）。
//   2. 一次性 deprecation warning（legacy `REGION` 字段命中时触发）。
//   3. 进程级缓存（区域在进程生命周期内不可变）。
//
// 我们即使每个使用者都是 server-side 也避免了 'server-only' —
// Playwright e2e fixtures 可传递导入 `currentRegion()`（通过
// `recordAudit` 和 `provisionSsoUser`）并且测试运行器是 Node，不是
// Next 打包程序。可传递 `@/lib/db` deps 仍然把模块
// 保留在实际上任何客户端包之外。

import { Region } from '@prisma/client';

import { env } from '@/env';
import { logger } from '@/lib/logger';
import { isLegacyRegionFallback, parseRegion } from '@/lib/region-parse';

let legacyWarningEmitted = false;

function emitLegacyWarning(value: string): void {
  if (legacyWarningEmitted) return;
  legacyWarningEmitted = true;
  logger.warn(
    {
      legacyValue: value,
      replacement: 'KITORA_REGION',
      removalIn: 'v0.10',
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

  const legacyValue = isLegacyRegionFallback({
    KITORA_REGION: env.KITORA_REGION,
    REGION: env.REGION,
  });
  if (legacyValue) emitLegacyWarning(legacyValue);

  // parseRegion 返回字符串字面量；这里转回 Prisma `Region` enum 让 ORM 调用类型对齐。
  cached = Region[parseRegion({ KITORA_REGION: env.KITORA_REGION, REGION: env.REGION })];
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
