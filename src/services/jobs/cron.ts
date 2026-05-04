/**
 * RFC 0008 §4.3 — Minimal cron expression matcher（无外部依赖）。
 *
 * 选不引 `cron-parser` / `croner` lib 的理由：
 *
 *   - PR-2 实际只用 4 种 cron 模式（`* * * * *` / `0 * * * *` / `0 3 * * *` /
 *     `0 4 * * *`），引一个 30KB 包不划算；
 *   - 后续 RFC 0009/0010 真出现 `15,45 * * * *` 列表 / 步长这类需求时，
 *     当前 parser 已经支持（见下方语法表）；如果仍不够再升级到外部 lib。
 *
 * 支持的语法（5 段，UTC 时区）：
 *
 *   ┌───────────── minute       (0 - 59)
 *   │ ┌─────────── hour         (0 - 23)
 *   │ │ ┌───────── day-of-month (1 - 31)
 *   │ │ │ ┌─────── month        (1 - 12)
 *   │ │ │ │ ┌───── day-of-week  (0 - 6, Sunday = 0)
 *   * * * * *
 *
 * 每段支持：
 *   - `*`           任意值
 *   - `N`           具体数字
 *   - `N-M`         闭区间范围
 *   - `*\/N`         步长（每 N 个）
 *   - `N-M/K`       带步长的范围
 *   - `A,B,C`       逗号分隔的列表（每项可以是上述任一种）
 *
 * **不支持**：name shortcuts（`@daily` / `@hourly`）、weekday 名称
 * （`MON` / `JAN`）、6 段（含秒）的 quartz 风格 — 业务用不上，留待外部 lib 升级。
 *
 * 时区：**全部 UTC**。RFC 0008 §10 明确 BackgroundJob 表 region-bound，但
 * cron 表达式本身用 UTC 让多 region 部署语义一致；CN region ops 自己换算
 * （UTC 03:00 = 北京时间 11:00；如需北京凌晨 3:00 则写 `0 19 * * *`）。
 */

interface CronExpression {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dom: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dow: ReadonlySet<number>;
}

// dom / dow OR-合判断阈值 —— 「全集」的元素数（31 天 / 7 周天）。
const FULL_DOM_SIZE = 31;
const FULL_DOW_SIZE = 7;

function parseField(field: string, min: number, max: number, fieldLabel: string): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') {
      throw new Error(`cron parse: empty term in "${fieldLabel}" field`);
    }
    const [rangePart, stepPart] = trimmed.split('/');
    const step = stepPart === undefined ? 1 : parseIntStrict(stepPart, fieldLabel);
    if (step <= 0) {
      throw new Error(`cron parse: step must be > 0 in "${fieldLabel}" field, got "${stepPart}"`);
    }

    let start: number;
    let end: number;
    if (rangePart === '*' || rangePart === undefined) {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [s, e] = rangePart.split('-');
      if (s === undefined || e === undefined) {
        throw new Error(`cron parse: malformed range "${rangePart}" in "${fieldLabel}" field`);
      }
      start = parseIntStrict(s, fieldLabel);
      end = parseIntStrict(e, fieldLabel);
      if (start > end) {
        throw new Error(`cron parse: range start > end ("${rangePart}") in "${fieldLabel}" field`);
      }
    } else {
      start = parseIntStrict(rangePart, fieldLabel);
      end = start;
    }

    if (start < min || end > max) {
      throw new Error(
        `cron parse: "${trimmed}" out of bounds [${min}-${max}] in "${fieldLabel}" field`,
      );
    }

    for (let i = start; i <= end; i += step) {
      result.add(i);
    }
  }
  return result;
}

function parseIntStrict(value: string, fieldLabel: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`cron parse: not an integer "${value}" in "${fieldLabel}" field`);
  }
  return parseInt(value, 10);
}

/**
 * 解析 cron 表达式为 5 个 Set<number>。无效表达式抛错（明确比 silent fail 好，
 * defineSchedule 在启动时会立刻冒出来）。
 * @param cron - cron 表达式字符串。
 * @returns 解析后的 cron 表达式。
 * @throws 如果 cron 表达式格式无效。
 */
export function parseCronExpression(cron: string): CronExpression {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron parse: expected 5 fields (minute hour dom month dow), got ${parts.length} in "${cron}"`,
    );
  }
  // noUncheckedIndexedAccess 让 parts[i] 是 string | undefined；上面已校验 length === 5，
  // 这里逐一守护 undefined 保证类型收窄到 string。
  const [m, h, dom, mo, dow] = parts;
  if (
    m === undefined ||
    h === undefined ||
    dom === undefined ||
    mo === undefined ||
    dow === undefined
  ) {
    throw new Error(`cron parse: failed to destructure 5 fields from "${cron}"`);
  }
  return {
    minute: parseField(m, 0, 59, 'minute'),
    hour: parseField(h, 0, 23, 'hour'),
    dom: parseField(dom, 1, 31, 'day-of-month'),
    month: parseField(mo, 1, 12, 'month'),
    dow: parseField(dow, 0, 6, 'day-of-week'),
  };
}

/**
 * 给定 cron 表达式与一个 Date（UTC 解释），判断该分钟是否匹配。
 *
 * 注意：cron 标准的 `dom` / `dow` 在「都不为 *」时是 OR 关系（任一匹配即触发）。
 * 这里采纳同款语义，避免与一般认知不一致。
 * @param cron - cron 表达式字符串。
 * @param date - 要检查的日期。
 * @returns 是否匹配。
 */
export function matchesCron(cron: string, date: Date): boolean {
  return matchesParsed(parseCronExpression(cron), date);
}

function matchesParsed(expr: CronExpression, date: Date): boolean {
  const minuteOk = expr.minute.has(date.getUTCMinutes());
  const hourOk = expr.hour.has(date.getUTCHours());
  const monthOk = expr.month.has(date.getUTCMonth() + 1);
  const domOk = expr.dom.has(date.getUTCDate());
  const dowOk = expr.dow.has(date.getUTCDay());

  // dom / dow OR 逻辑（标准 Vixie cron 行为）：除非两者都未限定（== 全集），否则
  // 只要一个匹配就算匹配。这里通过比较 size 与全集大小推断「是否限定」。
  const domLimited = expr.dom.size < FULL_DOM_SIZE;
  const dowLimited = expr.dow.size < FULL_DOW_SIZE;
  const dayOk = domLimited && dowLimited ? domOk || dowOk : domOk && dowOk;

  return minuteOk && hourOk && monthOk && dayOk;
}

/**
 * 将 Date 向下取整到分钟，返回 unix epoch minutes（unix seconds / 60）。
 *
 * schedule runId 形如 `schedule:<name>:<unixMinute>` —— 同分钟内重复触发自然
 * 走 (type, runId) unique 的 P2002 swallow 去重（RFC 0008 §4.3）。
 * @param date - 要取整的日期。
 * @returns Unix 分钟数。
 */
export function floorToUnixMinute(date: Date): number {
  return Math.floor(date.getTime() / 60_000);
}
