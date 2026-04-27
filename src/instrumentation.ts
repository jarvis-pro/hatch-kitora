/**
 * Next.js 检测钩子 — 在进程启动时接通 Sentry SDK。
 *
 * 注意：`CredentialsSignin` stderr 过滤器位于 Node `--require`
 * 预加载（`scripts/silence-auth-noise.cjs`），而不是这里——`register()` 运行
 * 在 Next.js 的记录器已经捕获其 stderr 流之后。
 *
 * 文档：https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
    // RFC 0005 — 快速失败地区检查。如果该进程认为它
    // 正在服务的部署区域与数据库中已有的不一致，
    // 拒绝启动：中国堆栈绝不能写入 GLOBAL 行，反之亦然。
    // 检查仅在 Node 运行时运行——Edge 无法打开 Prisma 连接——
    // 并且仅作为软断言；首次启动数据库（还没有组织）通过。
    await import('@/lib/region-startup-check').then((m) => m.assertRegionMatchesDatabase());
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Sentry 将助手导出为 `captureRequestError`；Next.js 寻找
// `onRequestError`。以预期的名称重新导出。
export { captureRequestError as onRequestError } from '@sentry/nextjs';
