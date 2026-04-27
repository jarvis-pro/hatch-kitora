import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * RFC 0003 PR-2 — webhook 有效载荷签名（HMAC-SHA256 超过 `<ts>.<body>`）。
 *
 * 与 Stripe / GitHub 风格的"方案签名"头兼容。在无 `server-only`
 * 模块中，以便 e2e 套件（和阅读文档的集成商）可以逐字提升
 * 验证函数。
 *
 * 出站头形状：
 *   X-Kitora-Signature: t=1745723404,v1=<hex sha256>
 *
 * 接收者必须执行的验证步骤：
 *   1. 从头中解析 `t` 和 `v1`。
 *   2. 如果 `abs(now - t) > MAX_AGE_SECONDS`，拒绝（重放窗口）。
 *   3. 重新计算 `HMAC_SHA256(secret, t + "." + rawBody)` 并常数时间
 *      与 `v1` 值比较。
 */

const MAX_AGE_SECONDS = 300; // 5 分钟 — RFC 0003 §2.3

interface SignOpts {
  secret: string;
  /** 原始（已字符串化的）body。调用者必须传递接收者将看到的*精确*字节。*/
  body: string;
  /** 可选的测试注入；默认为当前纪元秒。*/
  timestamp?: number;
}

export interface SignedHeaders {
  /** `X-Kitora-Signature` 值（例如 `t=...,v1=...`）。*/
  signature: string;
  /** 纪元秒——已编码到 `signature` 中，但为单独的 `X-Kitora-Timestamp` 头公开。*/
  timestamp: number;
}

export function signWebhookPayload(opts: SignOpts): SignedHeaders {
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${opts.body}`;
  const v1 = createHmac('sha256', opts.secret).update(signedPayload).digest('hex');
  return {
    signature: `t=${ts},v1=${v1}`,
    timestamp: ts,
  };
}

interface VerifyOpts {
  secret: string;
  /** 接收者获得的原始字节——不能重新字符串化。*/
  body: string;
  /** 要验证的头值，例如 `t=...,v1=...`。*/
  header: string;
  /** 覆盖最大重放窗口（秒）。默认 300。*/
  maxAgeSeconds?: number;
  /** 为测试覆盖"现在"。默认为当前纪元秒。*/
  now?: number;
}

export type VerifyVerdict =
  | { ok: true }
  | { ok: false; reason: 'malformed-header' | 'expired' | 'bad-signature' };

/**
 * 纯函数验证器，集成商可以直接放入其处理程序。
 * 在文档网站中逐字镜像，以便片段保持同步。
 */
export function verifyWebhookSignature(opts: VerifyOpts): VerifyVerdict {
  const parts = opts.header.split(',').map((p) => p.trim());
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === 't') t = Number.parseInt(v, 10);
    else if (k === 'v1') v1 = v;
  }
  if (t === null || Number.isNaN(t) || !v1) {
    return { ok: false, reason: 'malformed-header' };
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const window = opts.maxAgeSeconds ?? MAX_AGE_SECONDS;
  if (Math.abs(now - t) > window) {
    return { ok: false, reason: 'expired' };
  }

  const expected = createHmac('sha256', opts.secret).update(`${t}.${opts.body}`).digest('hex');
  // 按 Buffer 进行常数时间比较；在 timingSafeEqual 前长度必须匹配，
  // 因此进行显式长度检查。
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true };
}
