// 注意：这里故意*没有* `'server-only'` — Playwright e2e 测试和
// tsx CLI 脚本通过 `runWebhookCronTick` 和其他服务器流
// 传递导入这个。传递的 `resend` SDK + `@/env` 导入是
// Node 专用，所以意外的客户端打包仍会大声失败。
import { Resend } from 'resend';

import { env } from '@/env';

let cached: Resend | null = null;

export function getResend(): Resend {
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set. Configure it in your environment.');
  }
  cached ??= new Resend(env.RESEND_API_KEY);
  return cached;
}
