/**
 * RFC 0008 §6 PR-3 — email.send job + enqueueEmail helper 单元测试。
 *
 * 覆盖：
 *   - defineJob 注册参数；
 *   - zod discriminated union 校验三个 template 支的 props 形状（缺 / 错 props 应拒）；
 *   - run handler：调对应 React Email 组件 + sendEmail，传参形状正确；
 *   - enqueueEmail helper 转调 enqueueJob('email.send', ...) 形状正确；
 *   - 不知道的 template → 校验失败。
 */

import { OrgRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('@/services/jobs/enqueue', () => ({
  enqueueJob: vi.fn(),
}));

import { sendEmail } from '@/lib/email/send';
import { enqueueJob } from '@/services/jobs/enqueue';

import type { JobContext } from '../registry';
import { emailSendJob, enqueueEmail, type EmailPayload } from './email-send';

const mockedSendEmail = sendEmail as unknown as ReturnType<typeof vi.fn>;
const mockedEnqueueJob = enqueueJob as unknown as ReturnType<typeof vi.fn>;

function ctxStub<T>(payload: T): JobContext<T> {
  const noop = vi.fn();
  const stubLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    silent: noop,
    level: 'info',
    child: vi.fn(),
  };
  stubLogger.child.mockReturnValue(stubLogger);
  return {
    payload,
    attempt: 1,
    jobId: 'test-job',
    workerId: 'test-worker',
    logger: stubLogger as unknown as JobContext<T>['logger'],
  };
}

describe('emailSendJob defineJob 参数', () => {
  it('注册值正确', () => {
    expect(emailSendJob.type).toBe('email.send');
    expect(emailSendJob.maxAttempts).toBe(5);
    expect(emailSendJob.retentionDays).toBe(7);
    expect(emailSendJob.retry).toBe('exponential');
    expect(emailSendJob.timeoutMs).toBe(15_000);
    expect(emailSendJob.queue).toBe('default');
  });
});

describe('emailSendJob.payloadSchema (zod discriminated union)', () => {
  it('password-reset 合法 payload 通过', () => {
    const result = emailSendJob.payloadSchema.safeParse({
      template: 'password-reset',
      to: 'alice@example.com',
      subject: 'Reset your password',
      props: { resetUrl: 'https://kitora.io/reset?token=abc', name: 'Alice' },
    });
    expect(result.success).toBe(true);
  });

  it('password-reset 缺 resetUrl → 拒', () => {
    const result = emailSendJob.payloadSchema.safeParse({
      template: 'password-reset',
      to: 'alice@example.com',
      subject: 'Reset',
      props: { name: 'Alice' },
    });
    expect(result.success).toBe(false);
  });

  it('org-invitation 全可选 props 通过', () => {
    const result = emailSendJob.payloadSchema.safeParse({
      template: 'org-invitation',
      to: 'bob@example.com',
      subject: 'You are invited',
      props: {},
    });
    expect(result.success).toBe(true);
  });

  it('org-invitation role 是 OrgRole enum', () => {
    const result = emailSendJob.payloadSchema.safeParse({
      template: 'org-invitation',
      to: 'bob@example.com',
      subject: 'You are invited',
      props: { role: OrgRole.ADMIN, acceptUrl: 'https://kitora.io/invite/x' },
    });
    expect(result.success).toBe(true);
  });

  it('data-export-ready 缺 downloadUrl → 拒', () => {
    const result = emailSendJob.payloadSchema.safeParse({
      template: 'data-export-ready',
      to: 'carol@example.com',
      subject: 'Export ready',
      props: { scope: 'USER' },
    });
    expect(result.success).toBe(false);
  });

  it('data-export-ready scope 必须是 USER | ORG', () => {
    const result = emailSendJob.payloadSchema.safeParse({
      template: 'data-export-ready',
      to: 'carol@example.com',
      subject: 'Export ready',
      props: {
        downloadUrl: 'https://kitora.io/exports/x.zip',
        scope: 'BAD',
      },
    });
    expect(result.success).toBe(false);
  });

  it('未知 template → 拒', () => {
    const result = emailSendJob.payloadSchema.safeParse({
      template: 'unknown-template',
      to: 'x@example.com',
      subject: 'x',
      props: {},
    });
    expect(result.success).toBe(false);
  });

  it('to 非合法 email → 拒', () => {
    const result = emailSendJob.payloadSchema.safeParse({
      template: 'password-reset',
      to: 'not-an-email',
      subject: 'Reset',
      props: { resetUrl: 'https://kitora.io/reset' },
    });
    expect(result.success).toBe(false);
  });

  it('subject 超过 200 → 拒', () => {
    const longSubject = 'x'.repeat(201);
    const result = emailSendJob.payloadSchema.safeParse({
      template: 'password-reset',
      to: 'a@b.com',
      subject: longSubject,
      props: { resetUrl: 'https://kitora.io/reset' },
    });
    expect(result.success).toBe(false);
  });
});

describe('emailSendJob.run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('password-reset → 调 sendEmail，传对的 to / subject / react', async () => {
    mockedSendEmail.mockResolvedValueOnce({ id: 'msg-1' });
    const payload: EmailPayload = {
      template: 'password-reset',
      to: 'alice@example.com',
      subject: 'Reset your password',
      props: { resetUrl: 'https://kitora.io/reset?t=x', name: 'Alice' },
    };

    const result = await emailSendJob.run(ctxStub(payload));

    expect(result).toBeNull();
    expect(mockedSendEmail).toHaveBeenCalledOnce();
    const arg = mockedSendEmail.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      react: unknown;
    };
    expect(arg.to).toBe('alice@example.com');
    expect(arg.subject).toBe('Reset your password');
    // react 是 React 元素 —— 验证能识别为 ReactElement（带 type / props）。
    expect(arg.react).toBeTruthy();
  });

  it('org-invitation → 调 sendEmail', async () => {
    mockedSendEmail.mockResolvedValueOnce({ id: 'msg-2' });
    const payload: EmailPayload = {
      template: 'org-invitation',
      to: 'bob@example.com',
      subject: 'You are invited to Acme',
      props: {
        orgName: 'Acme',
        inviterName: 'Alice',
        role: OrgRole.MEMBER,
        acceptUrl: 'https://kitora.io/invite/abc',
      },
    };

    await emailSendJob.run(ctxStub(payload));

    expect(mockedSendEmail).toHaveBeenCalledOnce();
    const arg = mockedSendEmail.mock.calls[0]?.[0] as { to: string; subject: string };
    expect(arg.to).toBe('bob@example.com');
    expect(arg.subject).toBe('You are invited to Acme');
  });

  it('data-export-ready → 调 sendEmail', async () => {
    mockedSendEmail.mockResolvedValueOnce({ id: 'msg-3' });
    const payload: EmailPayload = {
      template: 'data-export-ready',
      to: 'carol@example.com',
      subject: 'Your data export is ready',
      props: {
        downloadUrl: 'https://kitora.io/exports/job-x/download',
        scope: 'ORG',
        appUrl: 'https://kitora.io',
        name: 'Carol',
      },
    };

    await emailSendJob.run(ctxStub(payload));
    expect(mockedSendEmail).toHaveBeenCalledOnce();
  });

  it('sendEmail 抛错 → run 透传给 runner（让 retry 接管）', async () => {
    mockedSendEmail.mockRejectedValueOnce(new Error('resend-503'));
    const payload: EmailPayload = {
      template: 'password-reset',
      to: 'a@b.com',
      subject: 'Reset',
      props: { resetUrl: 'https://kitora.io/reset' },
    };

    await expect(emailSendJob.run(ctxStub(payload))).rejects.toThrow('resend-503');
  });
});

describe('enqueueEmail helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('转调 enqueueJob("email.send", payload, opts)', async () => {
    mockedEnqueueJob.mockResolvedValueOnce({ id: 'job-1', deduplicated: false });

    const payload: EmailPayload = {
      template: 'password-reset',
      to: 'alice@example.com',
      subject: 'Reset',
      props: { resetUrl: 'https://kitora.io/reset' },
    };
    const result = await enqueueEmail(payload, { runId: 'email:password-reset:user:1' });

    expect(result).toEqual({ id: 'job-1', deduplicated: false });
    expect(mockedEnqueueJob).toHaveBeenCalledWith('email.send', payload, {
      runId: 'email:password-reset:user:1',
    });
  });

  it('opts 缺省时透传空对象', async () => {
    mockedEnqueueJob.mockResolvedValueOnce({ id: 'job-2', deduplicated: false });

    await enqueueEmail({
      template: 'org-invitation',
      to: 'b@c.com',
      subject: 'invite',
      props: {},
    });

    expect(mockedEnqueueJob).toHaveBeenCalledWith(
      'email.send',
      expect.objectContaining({ template: 'org-invitation' }),
      {},
    );
  });
});
