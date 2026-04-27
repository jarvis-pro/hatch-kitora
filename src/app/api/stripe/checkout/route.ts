import { NextResponse } from 'next/server';
import { z } from 'zod';

import { env } from '@/env';
import { requireActiveOrg } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { stripe } from '@/lib/stripe/client';
import { getOrCreateStripeCustomerId } from '@/lib/stripe/customer';

const schema = z.object({
  priceId: z.string().min(3),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

/**
 * POST /api/stripe/checkout
 *
 * 为已认证的组织创建 Stripe 结账会话。
 *
 * @param request - 请求对象，body 应包含：
 *   - `priceId` (string, 必需): Stripe 价格 ID，最少 3 个字符
 *   - `successUrl` (string, 可选): 结账成功后的重定向 URL
 *   - `cancelUrl` (string, 可选): 用户取消结账后的重定向 URL
 *
 * @returns 成功时返回 { url: string }（Stripe 结账页 URL）；
 *          鉴权失败返回 { error: 'unauthorized' } (401)；
 *          参数错误返回 { error: 'invalid-input' } (400)；
 *          Stripe 调用失败返回 { error: 'checkout-failed' } (500)。
 */
export async function POST(request: Request) {
  // 鉴权：要求当前会话对应一个活跃的组织
  const me = await requireActiveOrg().catch(() => null);
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 解析和验证 JSON body
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-input' }, { status: 400 });
  }

  // 获取或创建该组织对应的 Stripe 客户 ID
  const customerId = await getOrCreateStripeCustomerId(me.orgId);
  const baseUrl = env.NEXT_PUBLIC_APP_URL;

  try {
    // 调用 Stripe 创建订阅结账会话
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: parsed.data.priceId, quantity: 1 }],
      success_url: parsed.data.successUrl ?? `${baseUrl}/dashboard?checkout=success`,
      cancel_url: parsed.data.cancelUrl ?? `${baseUrl}/pricing?checkout=canceled`,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      client_reference_id: me.orgId,
      subscription_data: {
        // orgId 是 webhook resolveOwnership() 目前唯一查询的来源；
        // userId 仅用于在 Stripe 仪表盘中让人类可读，不作业务依据。
        metadata: { orgId: me.orgId, ownerUserId: me.userId },
      },
    });

    return NextResponse.json({ url: checkout.url });
  } catch (error) {
    // Stripe 调用出错，记录并返回通用错误响应
    logger.error({ err: error }, 'Stripe 结账会话创建失败');
    return NextResponse.json({ error: 'checkout-failed' }, { status: 500 });
  }
}
