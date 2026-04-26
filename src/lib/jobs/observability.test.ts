/**
 * RFC 0008 §4.8 / §6 PR-1 — Observability 钩子测试。
 *
 * 验证：
 *   - 默认 metrics hook 是 noop（不抛错、不返回值）；
 *   - setMetricsHook 注入后所有调用打到注入实现；
 *   - __resetMetrics 让 hook 回 noop；
 *   - withJobTransaction 透传成功值与异常（v1 thin wrapper 不吞错）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetMetrics, jobMetrics, setMetricsHook, withJobTransaction } from './observability';

describe('jobMetrics', () => {
  beforeEach(() => __resetMetrics());

  it('默认 noop hook 不抛错', () => {
    expect(() => jobMetrics().onSuccess('x', 100)).not.toThrow();
    expect(() => jobMetrics().onFailure('x', 100, true)).not.toThrow();
    expect(() => jobMetrics().onDeadLetter('x')).not.toThrow();
    expect(() => jobMetrics().onTickComplete(100, 5)).not.toThrow();
  });

  it('setMetricsHook 注入后所有 4 个回调都被打到', () => {
    const hook = {
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      onDeadLetter: vi.fn(),
      onTickComplete: vi.fn(),
    };
    setMetricsHook(hook);

    jobMetrics().onSuccess('email.send', 250);
    jobMetrics().onFailure('email.send', 250, true);
    jobMetrics().onDeadLetter('email.send');
    jobMetrics().onTickComplete(1500, 10);

    expect(hook.onSuccess).toHaveBeenCalledWith('email.send', 250);
    expect(hook.onFailure).toHaveBeenCalledWith('email.send', 250, true);
    expect(hook.onDeadLetter).toHaveBeenCalledWith('email.send');
    expect(hook.onTickComplete).toHaveBeenCalledWith(1500, 10);
  });

  it('__resetMetrics 让 hook 回 noop（注入的 spy 不再被打到）', () => {
    const onSuccess = vi.fn();
    setMetricsHook({
      onSuccess,
      onFailure: vi.fn(),
      onDeadLetter: vi.fn(),
      onTickComplete: vi.fn(),
    });

    __resetMetrics();
    jobMetrics().onSuccess('x', 1);

    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe('withJobTransaction', () => {
  it('成功路径透传返回值', async () => {
    const result = await withJobTransaction('test.t', 'job-1', 1, async () => 'value');
    expect(result).toBe('value');
  });

  it('handler 抛错 → 透传给上层（v1 不吞错）', async () => {
    await expect(
      withJobTransaction('test.t', 'job-1', 1, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('attempt 大于 1 时仍透传（多次重试不影响 wrapper 本身）', async () => {
    const result = await withJobTransaction('test.t', 'job-1', 5, async () => 42);
    expect(result).toBe(42);
  });
});
