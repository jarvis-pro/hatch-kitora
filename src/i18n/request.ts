import { getRequestConfig } from 'next-intl/server';

import { routing, type Locale } from './routing';

/**
 * next-intl 国际化请求配置。
 *
 * 为每个请求返回当前的区域设置、消息字典、时区和时刻。
 * 若请求的区域设置不在支持的列表中，则回退到默认区域。
 *
 * @returns 包含 locale、messages、timeZone 和 now 的配置对象。
 */
export default getRequestConfig(async ({ requestLocale }) => {
  // 解析来自请求的区域设置（可能来自 URL 路径或 Accept-Language header）
  const requested = await requestLocale;
  // 验证请求的区域设置是否在支持的列表中，否则使用默认区域
  const locale = (routing.locales as readonly string[]).includes(requested ?? '')
    ? (requested as Locale)
    : routing.defaultLocale;

  return {
    locale,
    // 动态导入该区域的消息字典
    messages: (await import(`../../messages/${locale}.json`)).default,
    // 统一使用 UTC 时区，避免跨地域时区混乱
    timeZone: 'UTC',
    // 当前时刻，用于日期格式化和相对时间计算
    now: new Date(),
  };
});
