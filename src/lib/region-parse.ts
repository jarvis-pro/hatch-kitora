/**
 * RFC 0005 — 零依赖的 region 解析纯函数。
 *
 * 同时被两个入口共享：
 *   1. `src/lib/region.ts` — Node 运行时主入口，外面包了缓存与 deprecation logger。
 *   2. `src/middleware.ts` — Edge 运行时无法 import Prisma / pino，需要纯字符串逻辑。
 *
 * 这个文件只接受 `process.env`-shaped 的入参 + 返回字面量字符串，不依赖 `@prisma/client`、
 * 不依赖 `pino`、不依赖 `@/env`，所以两个 runtime 都可以安全 import。任何对解析规则的
 * 改动都在这里改一次，两端自动同步。
 */

export type RegionLiteral = 'GLOBAL' | 'CN' | 'EU';

/**
 * 仅接受 v0.5 实际运送的遗留小写 `REGION` 值。`eu` 从未在 legacy 期出现。
 */
const LEGACY_REGION_MAP: Record<string, RegionLiteral> = {
  global: 'GLOBAL',
  cn: 'CN',
};

export interface RegionEnvSource {
  KITORA_REGION?: string;
  REGION?: string;
}

/**
 * 解析当前部署服务的 region。优先级：
 *   1. `KITORA_REGION`（'GLOBAL' | 'CN' | 'EU'）—— 规范字段。
 *   2. `REGION`（'global' | 'cn'）—— 已弃用窗口期支持，v0.10 移除。
 *   3. 都未设置 —— 默认 `GLOBAL`，对 dev / 测试友好。
 *
 * 调用方传入一个 env-shaped 对象（一般是 `process.env` 或经 `@/env` 校验过的 `env`）。
 *
 * @returns `'GLOBAL' | 'CN' | 'EU'` 字面量。
 */
export function parseRegion(source: RegionEnvSource): RegionLiteral {
  const canonical = source.KITORA_REGION;
  if (canonical === 'GLOBAL' || canonical === 'CN' || canonical === 'EU') {
    return canonical;
  }
  const legacy = source.REGION;
  if (legacy && LEGACY_REGION_MAP[legacy]) {
    return LEGACY_REGION_MAP[legacy];
  }
  return 'GLOBAL';
}

/**
 * 当 `parseRegion` 的解析路径**实际**回退到了 legacy `REGION` 时返回该值，
 * 用于上层 logger 触发一次性 deprecation warning。
 *
 * 注意：仅当 canonical `KITORA_REGION` 取值合法（'GLOBAL'/'CN'/'EU'）时才视为「未回退」。
 * 一个无效的 canonical 值（如 'XX'）后跟一个 legacy `REGION='cn'`，仍会被 `parseRegion`
 * 当作 legacy 路径处理 —— 这里的判断必须与之严格一致，否则会漏掉警告。
 */
export function isLegacyRegionFallback(source: RegionEnvSource): string | null {
  const canonical = source.KITORA_REGION;
  if (canonical === 'GLOBAL' || canonical === 'CN' || canonical === 'EU') return null;
  if (source.REGION && LEGACY_REGION_MAP[source.REGION]) return source.REGION;
  return null;
}
