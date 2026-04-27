import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并并去重 Tailwind 类名。
 *
 * 先用 `clsx` 处理条件类、数组、对象等多种入参形式，再用 `twMerge`
 * 解决同组工具类（如 `px-2 px-4`）的覆盖问题，保留最后生效的那一个。
 *
 * @param inputs 任意数量的 className 入参，支持字符串、数组、对象等。
 * @returns 经过合并与去重后的最终类名字符串。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 将相对路径拼接为完整的站点绝对 URL。
 *
 * 以 `process.env.NEXT_PUBLIC_APP_URL` 为基准；若未设置则回退到本地开发地址
 * `http://localhost:3000`。会自动补齐路径前的 `/`，避免拼接错误。
 *
 * @param path 站内相对路径，可带或不带前导 `/`。
 * @returns 形如 `https://example.com/foo` 的完整 URL。
 */
export function absoluteUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * 按指定语言环境格式化日期，输出形如 `Apr 27, 2026` 的人类可读字符串。
 *
 * @param date Date 实例或可被 `new Date()` 解析的日期字符串。
 * @param locale BCP 47 语言标签，默认 `en-US`，传入 `zh-CN` 即可得到中文格式。
 * @returns 已本地化的短日期字符串。
 */
export function formatDate(date: Date | string, locale = 'en-US'): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(typeof date === 'string' ? new Date(date) : date);
}

/**
 * 将以"分"为单位的金额格式化成对应货币的字符串。
 *
 * 内部除以 100 把"分"换算为"元"，再交由 `Intl.NumberFormat` 处理货币符号、
 * 千分位与小数位等本地化细节。
 *
 * @param amountInCents 金额，单位为最小货币单位（如美分、人民币分）。
 * @param currency ISO 4217 货币代码，默认 `USD`。
 * @param locale BCP 47 语言标签，默认 `en-US`。
 * @returns 已本地化的货币字符串，例如 `$12.34`、`￥12.34`。
 */
export function formatCurrency(amountInCents: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(amountInCents / 100);
}
