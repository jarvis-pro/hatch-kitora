import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/routing';
import { requireActiveOrg, requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';

export const metadata: Metadata = { title: '2FA required' };
export const dynamic = 'force-dynamic';

/**
 * RFC 0002 PR-4 — wall page shown to members of an org that has
 * `require2fa = true` whose own 2FA isn't enabled. Pure interstitial:
 * the only action is "go to /settings to enable 2FA". Once they do,
 * the wall lifts on the next request.
 *
 * Defensive checks here in case someone navigates directly:
 *   - already has 2FA on → straight to dashboard
 *   - org doesn't actually require 2FA → straight to dashboard
 */
export default async function TwoFaRequiredPage() {
  const me = await requireActiveOrg().catch(() => null);
  if (!me) redirect('/login');
  await requireUser(); // re-asserts an authenticated session

  const [org, user] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: me.orgId },
      select: { name: true, slug: true, require2fa: true },
    }),
    prisma.user.findUniqueOrThrow({
      where: { id: me.userId },
      select: { twoFactorEnabled: true },
    }),
  ]);
  if (!org.require2fa || user.twoFactorEnabled) {
    redirect('/dashboard');
  }

  const t = await getTranslations('onboarding.tfa');

  return (
    <div className="mx-auto max-w-xl space-y-6 py-12 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('description', { org: org.name })}</p>
      <div className="flex justify-center">
        <Button asChild>
          <Link href="/settings">{t('cta')}</Link>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('note')}</p>
    </div>
  );
}
