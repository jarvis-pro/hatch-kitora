import type { Prisma } from '@prisma/client';
import { PrismaClient } from '@prisma/client';

import { env } from '@/env';
import { logger } from '@/lib/logger';

/**
 * 显式给 PrismaClient 一个最小化 ClientOptions 范型 —— Prisma 5 的
 * `$on` 类型签名是 `<V extends GetEvents<ClientOptions['log']>>`，而
 * `GetEvents` 走 `T[0] | T[1]...` 字面量索引提取 `emit: 'event'` 那条。
 * 一旦 log 配置走宽类型（条件式三元、`Prisma.LogDefinition[]`），
 * `GetEvents` 会退化到 `never`，`$on('error', ...)` 就报"不能赋给 never"。
 * 这里在范型上 pin 死 error 事件的存在；运行时 log 数组照常构造，
 * 让 dev 多挂 query/warn 的 stdout 输出也不影响 $on 类型推导。
 */
type PrismaWithErrorEvents = PrismaClient<{
  log: [{ emit: 'event'; level: 'error' }];
}>;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaWithErrorEvents | undefined;
};

/**
 * 错误日志改用事件订阅而不是直接写 stderr —— 这样我们可以：
 *   * 过滤"预期内"的 race 错误（personal org / membership 并发创建撞
 *     P2002 已被 `ensurePersonalOrg` 的 try/catch 兜住，业务结果 OK）；
 *   * 真错误统一走 pino 输出，结构化、可被 Sentry 抓。
 *
 * 匹配尽可能窄 —— 只盖 personal org / membership 的 upsert 唯一冲突；
 * schema / FK / 连接断开等真错必须照常显形。
 */
function prismaErrorIsExpectedPersonalOrgRace(message: string): boolean {
  if (!message.includes('Unique constraint failed')) return false;
  return (
    message.includes('prisma.organization.upsert()') ||
    message.includes('prisma.membership.upsert()')
  );
}

// 运行时 log 数组：dev 多挂 query / warn 的 stdout，prod 只留 event-error。
// 类型上整体 cast 成 `LogDefinition[]`，配合上面 PrismaClient 的 generic
// 让 $on 看到字面量 `error`，构造器照常吃宽类型。
const log = (
  env.NODE_ENV === 'development'
    ? [
        { emit: 'stdout', level: 'query' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'event', level: 'error' },
      ]
    : [{ emit: 'event', level: 'error' }]
) as Prisma.LogDefinition[];

/**
 * 工厂方法只在"真正新建实例"那条路径上挂 $on 监听 —— 否则 dev 下 Next.js
 * 模块热重载会让本模块反复求值，命中 `globalForPrisma.prisma` 缓存的
 * 同一个 PrismaClient 但又叠一个新的 listener，最终一个 error 触发 N 次
 * `prisma-error` pino 日志。Prod 不缓存，每次启动只跑一遍工厂；安全。
 *
 * 构造器拿宽类型 log 数组，构造完成后再断言成带 error 事件 generic 的子型。
 * 比起把 generic pin 在构造器上，这样不需要让宽 `LogDefinition[]` 去满足
 * 严格的 tuple generic，避免 `Prisma.Subset` 校验失败；两个 PrismaClient
 * 范型实例化之间的转换要走 `unknown` 中转 TS 才放行。
 */
function createPrismaClient(): PrismaWithErrorEvents {
  const client = new PrismaClient({ log }) as unknown as PrismaWithErrorEvents;
  client.$on('error', (e) => {
    if (prismaErrorIsExpectedPersonalOrgRace(e.message)) return;
    logger.error({ target: e.target, msg: e.message }, 'prisma-error');
  });
  return client;
}

export const prisma: PrismaWithErrorEvents = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export type { Prisma } from '@prisma/client';
