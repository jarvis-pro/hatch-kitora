import { Link } from '@/i18n/routing';

/**
 * 认证模块的布局容器。
 *
 * 为登录、注册、重置密码等认证页面提供统一的居中卡片布局。
 *
 * @param children 认证页面内容
 * @returns 认证布局 JSX
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      {/* Kitora 品牌标志链接回首页 */}
      <Link href="/" className="mb-8 text-2xl font-bold tracking-tight">
        Kitora
      </Link>
      {/* 认证表单卡片容器 */}
      <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm sm:p-8">
        {children}
      </div>
    </div>
  );
}
