import { headers } from 'next/headers';

/**
 * 从常见代理头解析客户端 IP，回退到"unknown"。
 *
 * Next.js 请求范围外的调用（例如在直接驱动 server action / `recordAudit`
 * 的测试内）使 `headers()` 抛出。我们吞咽那个
 * 情况并返回 `'unknown'` 以便测试上下文中的调用者仍然获得
 * 可用字符串而不是审计插入炸掉。
 */
export async function getClientIp(): Promise<string> {
  try {
    const h = await headers();
    return (
      h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      h.get('x-real-ip') ??
      h.get('cf-connecting-ip') ??
      'unknown'
    );
  } catch {
    return 'unknown';
  }
}
