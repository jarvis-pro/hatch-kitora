/**
 * Next.js 服务启动钩子。Node 进程就绪后、接受第一个请求之前执行一次。
 *
 * 根据运行时环境（Node 或 Edge）加载对应的 Sentry 配置，
 * 并在 Node 运行时执行部署区域与数据库的一致性检查。
 *
 * 文档：https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  // Node.js 运行时初始化
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 加载服务端 Sentry 配置（包含源地图、上下文捕获等）
    await import('../sentry.server.config');

    // RFC 0005 — 区域与数据库一致性检查。
    // 本项目每个区域（GLOBAL / CN / EU）拥有独立的数据库，数据互不相通。
    // 此处在启动时核对：当前进程所在区域，是否与数据库中已有数据的归属区域一致。
    // 不一致则立即终止启动，防止"CN 服务写入 GLOBAL 数据库"之类的数据错乱事故。
    //
    // 两个限制：
    // 1. 仅在 Node 运行时执行，Edge 运行时无法建立 Prisma 数据库连接；
    // 2. 数据库为空（首次部署尚无数据）时视为一致，允许通过。
    await import('@/lib/region-startup-check').then((m) => m.assertRegionMatchesDatabase());
  }

  // Edge 运行时初始化
  if (process.env.NEXT_RUNTIME === 'edge') {
    // 加载边缘运行时 Sentry 配置（轻量级，用于 Middleware 等）
    await import('../sentry.edge.config');
  }
}

/**
 * 适配 Next.js 的 Sentry 请求错误处理器。
 *
 * Next.js 在捕获到请求级别的错误时，会自动调用当前文件中名为
 * `onRequestError` 的导出函数。Sentry 提供的对应实现叫做
 * `captureRequestError`，两者功能一致但名字不同。
 * 此处做一次重命名导出，让 Next.js 能找到并自动调用它。
 */
export { captureRequestError as onRequestError } from '@sentry/nextjs';
