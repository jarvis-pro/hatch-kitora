import { createNavigation } from 'next-intl/navigation';
import { defineRouting } from 'next-intl/routing';

/**
 * next-intl 路由配置。
 *
 * 定义应用支持的区域设置、默认区域、URL 前缀策略和自动检测行为。
 */
export const routing = defineRouting({
  // 支持的区域列表：英文 (en) 和 中文 (zh)
  locales: ['en', 'zh'] as const,
  // 当无法确定用户区域时的回退区域
  defaultLocale: 'en',
  // 'as-needed' — 在 URL 中仅为非默认区域添加前缀（/zh/...），默认区域无前缀（/...）
  localePrefix: 'as-needed',
  // 启用自动检测：根据 Accept-Language header 或客户端偏好推断区域
  localeDetection: true,
});

/**
 * 支持的区域类型。取值为 'en' 或 'zh'。
 */
export type Locale = (typeof routing.locales)[number];

/**
 * next-intl 导航助手。
 *
 * - `Link` — 支持 i18n 的链接组件，自动处理区域前缀
 * - `redirect` — 国际化重定向，保留当前区域上下文
 * - `usePathname` — Hook 用于获取不含区域前缀的当前路径名
 * - `useRouter` — Hook 用于国际化路由操作
 * - `getPathname` — 函数用于生成多语言路径
 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
