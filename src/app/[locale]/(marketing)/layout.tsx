import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteHeader } from '@/components/marketing/site-header';

/**
 * 营销模块的布局容器。
 *
 * 为首页、定价页等营销页面提供顶部导航栏和底部页脚的统一布局。
 *
 * @param children 营销页面内容
 * @returns 营销布局 JSX
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      {/* 顶部导航栏 */}
      <SiteHeader />
      {/* 页面主要内容，自动撑满中间空间 */}
      <main className="flex-1">{children}</main>
      {/* 底部页脚 */}
      <SiteFooter />
    </div>
  );
}
