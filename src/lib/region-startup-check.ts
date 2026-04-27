// RFC 0005 — 区域漂移安全检查。
//
// 通过 `instrumentation.ts` 在服务器启动时运行一次。合约：
//
//   * 如果数据库至少有一个 Organization 行，每行的
//     region 必须等于 `currentRegion()`。单个不匹配意味着
//     有人在已经服务另一个区域的堆栈上翻转了 `KITORA_REGION` —
//     拒绝启动以便我们无法将行写入错误的驻留。
//   * 如果数据库为空（全新部署，从未播种），通过。第
//     一个注册将为所有内容盖上规范区域。
//
// 我们刻意不在 `User` 或 `AuditLog` 表上失败 — 这些
// 可以从迁移回填之前携带历史行（每个
// 这样的行根据构造是 GLOBAL）我们宁愿不阻止一个 CN
// 堆栈刚好还没有看到任何注册启动。

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { currentRegion } from '@/lib/region';

let alreadyChecked = false;

export async function assertRegionMatchesDatabase(): Promise<void> {
  if (alreadyChecked) return;
  alreadyChecked = true;

  const expected = currentRegion();

  let conflict: { region: string; count: number } | null = null;
  try {
    // Group-by 在一个查询中给我们"存在的每个区域 + 数量" —
    // 即使在大型 orgs 表上也比宽 select 便宜。
    const rows = await prisma.organization.groupBy({
      by: ['region'],
      _count: { _all: true },
    });

    for (const row of rows) {
      if (row.region !== expected) {
        conflict = { region: row.region, count: row._count._all };
        break;
      }
    }
  } catch (err) {
    // 如果查询本身失败（DB 无法到达、迁移尚未运行、
    // ...）大声记录但不要杀死进程 — 我们不想要飘忽
    // 的飞行前检查把一个健康的应用打倒。下一个请求将重试
    // 隐式 DB 连接，ops 告警将捕获一个真实的中断。
    logger.warn({ err }, 'region-startup-check-skipped');
    return;
  }

  if (conflict) {
    logger.fatal(
      { expected, found: conflict.region, foundCount: conflict.count },
      'region-startup-mismatch',
    );
    // `process.exit` 而不是 `throw` 因为 Next.js 吞咽
    // instrumentation throws 并仅警告。我们希望容器
    // 崩溃所以编排器表现失败。
    process.exit(1);
  }

  logger.info({ region: expected }, 'region-startup-check-ok');
}
