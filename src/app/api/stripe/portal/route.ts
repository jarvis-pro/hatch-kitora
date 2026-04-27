import { NextResponse } from 'next/server';

import { env } from '@/env';
import { requireActiveOrg } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { stripe } from '@/lib/stripe/client';
import { getOrCreateStripeCustomerId } from '@/lib/stripe/customer';

/**
 * POST /api/stripe/portal
 *
 * 为已认证的组织创建 Stripe 客户门户会话。
 *
 * @param - 无 request body 或 query 参数
 *
 * @returns 成功时返回 { url: string }（Stripe 客户门户 URL）；
 *          鉴权失败返回 { error: 'unauthorized' } (401)；
 *          门户创建失败返回 { error: 'portal-failed' } (500)。
 */
export async function POST() {
  // 鉴权：要求当前会话对应一个活跃的组织
  const me = await requireActiveOrg().catch(() => null);
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    // 获取或创建该组织对应的 Stripe 客户 ID
    const customerId = await getOrCreateStripeCustomerId(me.orgId);
    // 调用 Stripe 创建客户门户会话
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${env.NEXT_PUBLIC_APP_URL}/settings`,
    });

    return NextResponse.json({ url: portal.url });
  } catch (error) {
    // Stripe 调用出错，记录并返回通用错误响应
    logger.error({ err: error }, 'Stripe 客户门户会话创建失败');
    return NextResponse.json({ error: 'portal-failed' }, { status: 500 });
  }
}
