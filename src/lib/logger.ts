// 注意：这里刻意*不*设置 'server-only' — Playwright e2e 测试和 tsx 驱动的 cron 脚本
// 都需要导入包含 `logger` 的 server-side 模块。可传递的 `@/env` 导入已在启动时
// 验证了 Node-only 环境变量，所以意外的客户端打包仍会失败并提示。Pino 本身有无害的浏览器构建。
import pino from 'pino';

import { env } from '@/env';

/**
 * Logger 设置。
 *
 * 在 Next.js 中我们刻意避免使用 pino 的 `transport` 选项 — 它会生成一个 worker thread
 * 来动态加载 `lib/worker.js`，这是 webpack 无法跟踪的路径，会导致 dev mode 崩溃并报告 MODULE_NOT_FOUND。
 *
 * 相反，我们总是向 stdout 输出 JSON。若想得到漂亮的 dev 输出，将 dev server 通过管道
 * 传入 pino-pretty：
 *
 *     pnpm dev | pnpm exec pino-pretty
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    app: 'kitora',
    env: env.NODE_ENV,
  },
});

export type Logger = typeof logger;
