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

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Accept invitation' };

interface Props {
  params: { token: string; locale: string };
}

export default async function AcceptInvitationPage({ params }: Props) {
  const { token } = params;
  const t = await getTranslations('orgs.invite');

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

  if (!inv || inv.revokedAt) {
    return <Status title={t('invalid.title')} body={t('invalid.body')} />;
  }
  if (inv.acceptedAt) {
    return <Status title={t('alreadyAccepted.title')} body={t('alreadyAccepted.body')} />;
  }
  if (inv.expiresAt.getTime() < Date.now()) {
    return <Status title={t('expired.title')} body={t('expired.body')} />;
  }

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
