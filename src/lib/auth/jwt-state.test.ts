/**
 * jwt-state 纯函数单测。
 *
 * 这两个函数是 src/lib/auth/index.ts 的 jwt callback 决策核心 —— 任何认证状态
 * 维度新增（订阅过期降级 / 邮箱待验证只读 / 企业账号被吊销 等）都会扎进这里。
 * 测试无 DB / 无 mock，纯输入输出。
 */

import { describe, expect, it } from 'vitest';

import { decideTfaPending, decideTokenLifecycle, type FreshUserSnapshot } from './jwt-state';

function fresh(overrides: Partial<FreshUserSnapshot> = {}): FreshUserSnapshot {
  return {
    sessionVersion: 0,
    role: 'USER',
    twoFactorEnabled: false,
    status: 'ACTIVE',
    region: 'GLOBAL',
    ...overrides,
  };
}

describe('decideTokenLifecycle', () => {
  it('fresh = null（用户被硬删除）→ kill', () => {
    const decision = decideTokenLifecycle({ sessionVersion: 1 }, null);
    expect(decision.kind).toBe('kill');
  });

  it('sessionVersion 不一致（"sign out everywhere" / 改密）→ kill', () => {
    const decision = decideTokenLifecycle({ sessionVersion: 1 }, fresh({ sessionVersion: 2 }));
    expect(decision.kind).toBe('kill');
  });

  it('sessionVersion 一致 → keep + 透传 fresh.role / status / region', () => {
    const decision = decideTokenLifecycle(
      { sessionVersion: 3 },
      fresh({
        sessionVersion: 3,
        role: 'ADMIN',
        status: 'PENDING_DELETION',
        region: 'CN',
      }),
    );
    expect(decision).toEqual({
      kind: 'keep',
      mutations: { role: 'ADMIN', status: 'PENDING_DELETION', region: 'CN' },
    });
  });

  it('token 上没有 sessionVersion（超老 token）→ kill 强制重新登录', () => {
    const decision = decideTokenLifecycle({ sessionVersion: undefined }, fresh());
    expect(decision.kind).toBe('kill');
  });

  it('mutations 永远从 fresh 读，不从 current（确保 admin 提升 / 区域回填即时生效）', () => {
    const decision = decideTokenLifecycle({ sessionVersion: 0 }, fresh({ role: 'ADMIN' }));
    expect(decision.kind === 'keep' && decision.mutations.role).toBe('ADMIN');
  });
});

describe('decideTfaPending', () => {
  describe('(a) trigger="update" + sessionTfa="verified" — /login/2fa 成功路径', () => {
    it('清 false（即使 fresh 仍开 2FA）', () => {
      expect(decideTfaPending(true, true, 'update', 'verified')).toBe(false);
    });
    it('清 false（即使 token 上 undefined）', () => {
      expect(decideTfaPending(undefined, true, 'update', 'verified')).toBe(false);
    });
    it('清 false（即使 fresh 关掉 2FA — 防御性双重清除）', () => {
      expect(decideTfaPending(true, false, 'update', 'verified')).toBe(false);
    });
  });

  describe('(b) fresh.twoFactorEnabled = false — 用户在会话中关掉 2FA', () => {
    it('清 false 让用户不卡在质询页', () => {
      expect(decideTfaPending(true, false, undefined, undefined)).toBe(false);
    });
    it('已经是 false 也保持 false（幂等）', () => {
      expect(decideTfaPending(false, false, undefined, undefined)).toBe(false);
    });
  });

  describe('(c) fresh.twoFactorEnabled = true + token 上 undefined — pre-PR-2 token 路径', () => {
    it('设 true（防旧 token 绕过新启用的 2FA）', () => {
      expect(decideTfaPending(undefined, true, undefined, undefined)).toBe(true);
    });
  });

  describe('维持原值（返回 undefined）', () => {
    it('current=true + fresh 启用 — 已等待 challenge', () => {
      expect(decideTfaPending(true, true, undefined, undefined)).toBeUndefined();
    });
    it('current=false + fresh 启用 — 已通过 challenge', () => {
      expect(decideTfaPending(false, true, undefined, undefined)).toBeUndefined();
    });
  });

  describe('其它 trigger 不影响 (a) 路径', () => {
    it('trigger="update" 但 sessionTfa 不是 "verified" → 不清 false', () => {
      expect(decideTfaPending(true, true, 'update', 'something-else')).toBeUndefined();
    });
    it('trigger="update" 但 sessionTfa 缺失 → 不清 false', () => {
      expect(decideTfaPending(true, true, 'update', undefined)).toBeUndefined();
    });
    it('trigger="signIn" 走 user 分支，但本函数仍按 fresh 决策', () => {
      // signIn 本来由 jwt callback 的 user-presence 分支处理；如果出于某种原因
      // 走到这里，按 fresh.twoFactorEnabled = false 仍清 false（路径一致性）。
      expect(decideTfaPending(undefined, false, 'signIn', undefined)).toBe(false);
    });
  });
});
