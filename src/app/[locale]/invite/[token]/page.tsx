import type { OrgRole } from '@prisma/client';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { InviteAcceptButton } from '@/components/account/invite-accept';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/routing';
import { auth } from '@/lib/auth';
import { hashToken } from '@/lib/auth/tokens';
import { prisma } from '@/lib/db';

// 禁用缓存，每次请求都重新验证邀请状态
export const dynamic = 'force-dynamic';

/**
 * 邀请接受页的元数据。
 */
export const metadata: Metadata = { title: 'Accept invitation' };

interface Props {
  params: { token: string; locale: string };
}

/**
 * 邀请接受页面。
 *
 * 允许用户接受组织邀请。验证邀请令牌、状态和邮箱匹配。
 * 支持未登录用户签约或重新登录。
 *
 * Server 端渲染，采用 i18n 国际化。
 *
 * @param params 路由参数，包含邀请令牌 token
 * @returns 邀请接受页面 JSX
 */
export default async function AcceptInvitationPage({ params }: Props) {
  const { token } = params;
  const t = await getTranslations('orgs.invite');

  // 将明文令牌进行哈希，以便与数据库中的哈希值比对
  const tokenHash = hashToken(token);
  const inv = await prisma.invitation.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      email: true,
      role: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
      organization: { select: { name: true, slug: true } },
    },
  });

  // 验证邀请有效性：存在、未被撤销
  if (!inv || inv.revokedAt) {
    return <Status title={t('invalid.title')} body={t('invalid.body')} />;
  }

  // 验证邀请未被接受
  if (inv.acceptedAt) {
    return <Status title={t('alreadyAccepted.title')} body={t('alreadyAccepted.body')} />;
  }

  // 验证邀请未过期
  if (inv.expiresAt.getTime() < Date.now()) {
    return <Status title={t('expired.title')} body={t('expired.body')} />;
  }

  // 检查当前登录用户的邮箱是否与邀请邮箱匹配
  const session = await auth();
  const sessionEmail = (session?.user?.email ?? '').toLowerCase();
  const matches = !!session?.user && sessionEmail === inv.email.toLowerCase();

  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center px-4 py-10">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{t('header', { org: inv.organization.name })}</CardTitle>
          <CardDescription>
            {t('subheader', {
              email: inv.email,
              role: t(`roles.${inv.role as OrgRole}`),
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!session?.user ? (
            <>
              <p className="text-sm text-muted-foreground">
                {t('mustSignIn', { email: inv.email })}
              </p>
              <div className="flex flex-col gap-2">
                <Button asChild className="w-full">
                  <Link href={`/login?next=/invite/${token}`}>{t('signInButton')}</Link>
                </Button>
                <Button asChild variant="outline" className="w-full">
                  <Link
                    href={`/signup?next=/invite/${token}&email=${encodeURIComponent(inv.email)}`}
                  >
                    {t('signUpButton')}
                  </Link>
                </Button>
              </div>
            </>
          ) : !matches ? (
            <>
              <p className="text-sm text-destructive">
                {t('errors.wrong-email', { email: inv.email })}
              </p>
              <Button asChild variant="outline" className="w-full">
                <Link href={`/login?next=/invite/${token}`}>{t('switchAccount')}</Link>
              </Button>
            </>
          ) : (
            <InviteAcceptButton token={token} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * 邀请状态显示组件。
 *
 * 用于显示邀请失败、已过期、已使用等各类状态消息。
 *
 * @param title 状态标题
 * @param body 状态描述文本
 * @returns 状态显示卡片 JSX
 */
function Status({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center px-4 py-10">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{body}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
