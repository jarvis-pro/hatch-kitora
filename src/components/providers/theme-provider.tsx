'use client';

import { ThemeProvider as NextThemesProvider, type ThemeProviderProps } from 'next-themes';

/**
 * 主题提供商包装组件。
 *
 * 包装 next-themes 的 ThemeProvider，为整个应用提供主题切换能力。
 * 允许用户在浅色/深色主题间切换，并持久化保存用户选择。
 *
 * @param props - 继承自 next-themes 的 ThemeProviderProps，
 *                包含 children 和其他主题配置参数。
 * @returns 将 next-themes 的 ThemeProvider 作为上下文包装器返回。
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
