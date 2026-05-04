/**
 * RFC 0008 §1.2 / §4.6 / PR-3 — Token / Invitation 表过期行清理。
 *
 * 现状（RFC 0008 §1.1 痛点）：PasswordResetToken / EmailVerificationToken /
 * Invitation 三个表的过期判定一直走「读时 expires < now() 就 ignore」的懒清，
 * 行从不删；每周 / 每月堆积上万行死数据，admin 后台拉表慢、磁盘缓慢膨胀。
 *
 * v1 清理策略（保守）：
 *
 *   - **PasswordResetToken** / **EmailVerificationToken**：删除 `consumedAt IS
 *     NOT NULL`（已消费、再没用）OR `expires < now() - 7d`（过期 + 7 天宽限给
 *     forensic 追查；7 天后纯死数据可清）。
 *   - **Invitation**：删除 `acceptedAt IS NOT NULL` 或 `revokedAt IS NOT NULL`
 *     已落定的；以及 `expiresAt < now() - 30d`（过期 + 30 天宽限 —— 邀请记录的
 *     forensic 价值高于 token，宽限期更长）。
 *
 * 为什么保留 7 / 30 天宽限：被「我没收到邮件」用户找到时仍能查到曾发过 token。
 * 真正的硬保留期由 RFC 0002 数据导出 + audit log 处理。
 *
 * `maxAttempts: 1` —— sweep 失败下一小时自然再来。`retentionDays: 7` 保留
 * 跑了什么的执行记录。
 *
 * Schedule：每小时第 0 分钟（`0 * * * *` UTC）—— token 表增长速度有限，
 * 1 小时分辨率充足；deletion / job-prune 都是日级活，token 给小时级是合理梯度。
 */

import { z } from 'zod';

import { defineJob, defineSchedule } from '@/services/jobs/define';
import { prisma } from '@/lib/db';

const PASSWORD_TOKEN_EXPIRES_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_TOKEN_EXPIRES_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const INVITATION_EXPIRES_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

interface TokenCleanupResult {
  passwordResetTokens: number;
  emailVerificationTokens: number;
  invitations: number;
}

export const tokenCleanupJob = defineJob({
  type: 'token.cleanup',
  payloadSchema: z.object({}).strict(),
  maxAttempts: 1,
  retentionDays: 7,
  retry: 'fixed',
  timeoutMs: 30_000,
  async run({ logger }): Promise<TokenCleanupResult> {
    const now = Date.now();
    const passwordCutoff = new Date(now - PASSWORD_TOKEN_EXPIRES_GRACE_MS);
    const emailCutoff = new Date(now - EMAIL_TOKEN_EXPIRES_GRACE_MS);
    const inviteCutoff = new Date(now - INVITATION_EXPIRES_GRACE_MS);

    const [passwordResetTokens, emailVerificationTokens, invitations] = await Promise.all([
      prisma.passwordResetToken.deleteMany({
        where: {
          OR: [{ consumedAt: { not: null } }, { expires: { lt: passwordCutoff } }],
        },
      }),
      prisma.emailVerificationToken.deleteMany({
        where: {
          OR: [{ consumedAt: { not: null } }, { expires: { lt: emailCutoff } }],
        },
      }),
      prisma.invitation.deleteMany({
        where: {
          OR: [
            { acceptedAt: { not: null } },
            { revokedAt: { not: null } },
            { expiresAt: { lt: inviteCutoff } },
          ],
        },
      }),
    ]);

    const result: TokenCleanupResult = {
      passwordResetTokens: passwordResetTokens.count,
      emailVerificationTokens: emailVerificationTokens.count,
      invitations: invitations.count,
    };

    if (
      result.passwordResetTokens > 0 ||
      result.emailVerificationTokens > 0 ||
      result.invitations > 0
    ) {
      logger.info(result, 'token-cleanup-deleted');
    }
    return result;
  },
});

defineSchedule({
  name: 'token-cleanup',
  cron: '0 * * * *', // 每小时第 0 分钟
  jobType: 'token.cleanup',
});
