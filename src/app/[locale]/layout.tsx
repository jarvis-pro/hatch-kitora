import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { ThemeProvider } from '@/components/providers/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { routing, type Locale } from '@/i18n/routing';
import { cn } from '@/lib/utils';

import '../globals.css';

// Google Fonts: Inter 用于无衬线正文
const fontSans = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

// Google Fonts: JetBrains Mono 用于代码和等宽文本
const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

/**
 * 全局元数据。
 *
 * 设置站点基础 SEO 和社交媒体分享信息。
 */
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  title: {
    default: 'Kitora — Production-ready SaaS starter',
    template: '%s · Kitora',
  },
  description:
    'Build, ship and scale a global SaaS with Next.js — auth, billing and i18n included.',
  keywords: ['Next.js', 'SaaS', 'Starter', 'Stripe', 'NextAuth', 'i18n'],
  authors: [{ name: 'Kitora' }],
  openGraph: {
    type: 'website',
    siteName: 'Kitora',
  },
  twitter: {
    card: 'summary_large_image',
  },
  robots: {
    index: true,
    follow: true,
  },
  icons: {
    icon: '/favicon.ico',
  },
};

/**
 * 视口和主题颜色配置。
 *
 * 设置响应式设计和深浅主题配色。
 */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
  width: 'device-width',
  initialScale: 1,
};

/**
 * 静态参数生成 — 为所有支持的语言预生成路由。
 *
 * @returns 各语言区域设置的参数数组
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

interface RootLayoutProps {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}

/**
 * 全局根布局。
 *
 * 包装所有页面，提供国际化上下文、主题提供器和 Toaster 组件。
 * 验证语言区域设置的有效性。
 *
 * @param children 所有子页面内容
 * @param params 路由参数，包含当前语言区域
 * @returns 根布局 JSX
 */
export default async function RootLayout({ children, params }: RootLayoutProps) {
  const { locale } = await params;

  // 验证语言区域有效性，若无效返回 404
  if (!routing.locales.includes(locale as Locale)) {
    notFound();
  }

  // 获取当前语言的国际化消息
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning>
      <body
        className={cn(
          'min-h-screen bg-background font-sans antialiased',
          fontSans.variable,
          fontMono.variable,
        )}
      >
        <NextIntlClientProvider messages={messages}>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            {children}
            <Toaster richColors position="top-right" />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
