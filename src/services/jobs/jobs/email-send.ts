/**
 * RFC 0008 §4.2 / §4.7 / PR-3 — `email.send` job + `enqueueEmail` helper。
 *
 * ## 设计权衡
 *
 * payload 用 zod **discriminated union**（按 `template` 字段判别），TS 编译期就拒
 * 错误的 `props` 形状，运行期 zod 二道防线再校一次（与 RFC 0008 §2「类型安全到
 * enqueue 边界」一致）。每加新模板要动两处：
 *
 *   1. 此文件的 `emailPayloadSchema` discriminator 列表加一支；
 *   2. `renderTemplate(payload)` switch 加一支。
 *
 * 双处声明的代价换来：调用方写 `enqueueEmail({ template: 'password-reset',
 * props: { ... } })` 时 IDE 自动补全准确 props，发布前类型错误就被抓出来。
 *
 * ## 首期覆盖范围（RFC §4.7）
 *
 * 仅「应失败重试」的三个场景：
 *
 *   - `password-reset` —— 用户点了「忘记密码」、邮件丢了用户卡死，必须重试；
 *   - `org-invitation` —— 邀请邮件丢了对方加不进 org；
 *   - `data-export-ready` —— 导出 zip 已生成，邮件丢了用户找不到下载链接（24h 过期）。
 *
 * 强一致场景（注册时的 verify-email、登录提示类的 2fa-enabled / -disabled、
 * fire-and-forget 类的 welcome / account-deletion-*）继续走 `sendEmail()` 同步直发，
 * 不通过本 job —— 这些场景重试 30s/2min 的延迟反而恶化体验。
 *
 * 重试参数：`maxAttempts: 5` + `retry: 'exponential'`，覆盖 webhook 同款 30s/2m/10m/1h
 * 退避曲线 5 阶（attempt 1-5 = [立即, 30s, 2m, 10m, 1h]），1 小时之后未投递成功
 * 翻 DEAD_LETTER；admin 可在 `/admin/jobs` 手动重试或 cancel。
 */

import { OrgRole } from '@prisma/client';
import type React from 'react';
import { z } from 'zod';

import DataExportReadyEmail from '@/emails/data-export-ready';
import OrgInvitationEmail from '@/emails/org-invitation';
import ResetPasswordEmail from '@/emails/reset-password';
import { sendEmail } from '@/lib/email/send';

import { defineJob } from '@/services/jobs/define';
import { enqueueJob, type EnqueueResult } from '@/services/jobs/enqueue';

// ── per-template props schemas ───────────────────────────────────────

const passwordResetPropsSchema = z.object({
  resetUrl: z.string().url(),
  name: z.string().min(1).optional(),
});

const orgInvitationPropsSchema = z.object({
  orgName: z.string().optional(),
  inviterName: z.string().optional(),
  role: z.nativeEnum(OrgRole).optional(),
  acceptUrl: z.string().url().optional(),
});

const dataExportReadyPropsSchema = z.object({
  name: z.string().min(1).optional(),
  appUrl: z.string().url().optional(),
  downloadUrl: z.string().url(),
  scope: z.enum(['USER', 'ORG']),
});

const baseEnvelopeShape = {
  to: z.string().email(),
  subject: z.string().min(1).max(200),
};

// ── discriminated union ──────────────────────────────────────────────

const emailPayloadSchema = z.discriminatedUnion('template', [
  z.object({
    ...baseEnvelopeShape,
    template: z.literal('password-reset'),
    props: passwordResetPropsSchema,
  }),
  z.object({
    ...baseEnvelopeShape,
    template: z.literal('org-invitation'),
    props: orgInvitationPropsSchema,
  }),
  z.object({
    ...baseEnvelopeShape,
    template: z.literal('data-export-ready'),
    props: dataExportReadyPropsSchema,
  }),
]);

export type EmailPayload = z.infer<typeof emailPayloadSchema>;

// ── job definition ──────────────────────────────────────────────────

export const emailSendJob = defineJob({
  type: 'email.send',
  payloadSchema: emailPayloadSchema,
  maxAttempts: 5,
  retentionDays: 7,
  retry: 'exponential',
  // sendEmail 内部走 Resend / Aliyun DirectMail 的 HTTP 调用；网络抖动场景下
  // 给 15s 余量，保留 def.timeoutMs - 5s 给重试决策本身的写库时间。
  timeoutMs: 15_000,
  async run({ payload, jobId, logger }) {
    const react = renderTemplate(payload);
    await sendEmail({
      to: payload.to,
      subject: payload.subject,
      react,
    });
    logger.info({ jobId, to: payload.to, template: payload.template }, 'email-sent-via-job');
    return null;
  },
});

/**
 * 将 payload 投影到对应的 React Email 模板。switch 必穷尽 —— 加新模板时 TS
 * `noFallthroughCasesInSwitch` + discriminated union 会让漏写的支强制冒错。
 * @param payload - 邮件负载。
 * @returns React Email 元素。
 */
function renderTemplate(payload: EmailPayload): React.ReactElement {
  switch (payload.template) {
    case 'password-reset':
      return ResetPasswordEmail(payload.props);
    case 'org-invitation':
      return OrgInvitationEmail(payload.props);
    case 'data-export-ready':
      return DataExportReadyEmail(payload.props);
  }
}

// ── enqueueEmail helper ─────────────────────────────────────────────

/**
 * 邮件入队选项。
 * @property runId - 幂等键；同 (type='email.send', runId) 在表里唯一，重复 enqueue 走 P2002 swallow。业务侧建议形如 `email:password-reset:user:${userId}`。
 * @property delayMs - 最早可被 claim 的时刻偏移，毫秒。一般无需指定（默认立即）。
 */
export interface EnqueueEmailOptions {
  runId?: string;
  delayMs?: number;
}

/**
 * 异步投递邮件（替代 `sendEmail()` 同步直发）。失败按 `email.send` 的 5 阶
 * 指数退避自动重试，最终失败进 DEAD_LETTER 让 admin 手工兜底。
 *
 * **强一致场景请仍用 `sendEmail()`** —— 注册验证邮件、登录提示等需要分钟级到达，
 * 等不到 30s/2m 的退避；走 enqueueEmail 反而让用户卡 30 秒看不到验证邮件。
 * @param payload - 邮件负载。
 * @param opts - 入队选项。
 * @returns 入队结果。
 */
export async function enqueueEmail(
  payload: EmailPayload,
  opts: EnqueueEmailOptions = {},
): Promise<EnqueueResult> {
  return enqueueJob('email.send', payload, opts);
}
