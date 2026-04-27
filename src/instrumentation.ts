/**
 * Next.js 检测钩子。在应用进程启动时执行初始化逻辑。
 *
 * 根据运行时环境（Node 或 Edge）加载对应的 Sentry 配置，
 * 并在 Node 运行时执行部署区域启动检查，确保数据库一致性。
 *
 * 注意：
 * - `CredentialsSignin` stderr 过滤器由 Node `--require` 预加载脚本
 *   `scripts/silence-auth-noise.cjs` 处理，而不是在这里，因为 `register()`
 *   执行时 Next.js 日志系统已接管 stderr 流。
 *
 * 文档：https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  // Node.js 运行时初始化
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 加载服务端 Sentry 配置（包含源地图、上下文捕获等）
    await import('../sentry.server.config');
    // RFC 0005 — 部署区域启动检查。快速失败机制：
    // 若进程认定的部署区域与数据库中现有数据的区域不一致，
    // 则拒绝启动。示例：中国堆栈不能向 GLOBAL 数据库写入，反之亦然。
    // 此检查仅在 Node 运行时执行（Edge 无法打开 Prisma 连接），
    // 并作为软断言：首次启动时数据库为空（无组织），允许通过。
    await import('@/lib/region-startup-check').then((m) => m.assertRegionMatchesDatabase());
  }
  // Edge 运行时初始化
  if (process.env.NEXT_RUNTIME === 'edge') {
    // 加载边缘运行时 Sentry 配置（轻量级，用于 Middleware 等）
    await import('../sentry.edge.config');
  }
}

/**
 * Sentry 错误处理器重新导出。
 *
 * Sentry SDK 导出错误处理函数为 `captureRequestError`，
 * 但 Next.js 期望名为 `onRequestError` 的导出。
 * 此处重新导出以适配 Next.js 命名约定。
 */
export { captureRequestError as onRequestError } from '@sentry/nextjs';
