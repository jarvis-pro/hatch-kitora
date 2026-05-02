/**
 * JWT 生命周期状态机 — 纯函数。
 *
 * 背景：`src/lib/auth/index.ts` 的 jwt callback 之前把以下五件事杂糅在一起：
 *   1. 调用 edge-safe authConfig.callbacks.jwt 拿基础 claim；
 *   2. 初始登录时铸 sid + 写 DeviceSession 行（IO）；
 *   3. 后续调用从 DB 拉 fresh user 然后判 sessionVersion / role / status / region；
 *   4. tfa_pending 三段状态切换（trigger=update / fresh.twoFactorEnabled）；
 *   5. 每请求 sid 验证（IO）。
 *
 * 任何新增维度（如「邮箱待验证才许只读」「订阅过期降级」）都会扎进这块。本文件
 * 把 #3 + #4 抽成两个纯函数，callback 只保留 IO，未来加一维状态时只需在这里
 * 改纯函数 + 给纯函数补一个 case 测试，不用动 callback 的事务/网络代码。
 */

export type Region = 'GLOBAL' | 'CN' | 'EU';
export type UserRole = 'USER' | 'ADMIN';
export type UserStatus = 'ACTIVE' | 'PENDING_DELETION';

/** Auth.js trigger 字面量子集 — `'update'` 是 `unstable_update()` 来的 session refresh。 */
export type JwtTrigger = 'signIn' | 'signUp' | 'update' | undefined;

/**
 * 从 DB 现拉的、决策需要的 User 字段子集。其它列（passwordHash 等）不应进入本模块。
 */
export interface FreshUserSnapshot {
  sessionVersion: number;
  role: UserRole;
  twoFactorEnabled: boolean;
  status: UserStatus;
  region: Region;
}

/**
 * 当前 JWT 已携带的、与本状态机相关的字段。其它字段（id / sid / sidHash 等）由
 * callback 层照常透传。
 */
export interface TokenStateInput {
  /** 上一次 jwt callback 回写到 token 里的 sessionVersion。 */
  sessionVersion?: number;
  /** 上一次 jwt callback 回写到 token 里的 tfa_pending。可能为 undefined（pre-PR-2 token）。 */
  tfa_pending?: boolean;
}

/**
 * `decideTokenLifecycle` 的两种返回：
 *   - `'kill'` — 调用方应直接 `return null` 让 Auth.js 当场作废这个 JWT；
 *   - `{ mutations }` — 把这些字段 merge 进 token，继续往后走。
 */
export type LifecycleDecision =
  | { kind: 'kill' }
  | {
      kind: 'keep';
      mutations: {
        role: UserRole;
        status: UserStatus;
        region: Region;
      };
    };

/**
 * 决策 token 整体生命周期：
 *   1. fresh 缺失（用户被硬删除）→ kill；
 *   2. fresh.sessionVersion 与 token 不一致（"sign out everywhere" / 改密 / 注销）→ kill；
 *   3. 其它情况返回需要 merge 的字段（role/status/region 始终从 fresh 反映）。
 *
 * **纯函数**：不依赖 DB / headers / Sentry。给定相同输入永远返回相同输出。
 *
 * @param current   token 已携带的状态字段
 * @param fresh     从 DB 现拉的 user 快照；user 行不存在时传 null
 */
export function decideTokenLifecycle(
  current: TokenStateInput,
  fresh: FreshUserSnapshot | null,
): LifecycleDecision {
  if (!fresh) return { kind: 'kill' };
  if (fresh.sessionVersion !== current.sessionVersion) return { kind: 'kill' };
  return {
    kind: 'keep',
    mutations: {
      role: fresh.role,
      status: fresh.status,
      region: fresh.region,
    },
  };
}

/**
 * 决策 `tfa_pending` 这一位的下一个值。三个转换（与 RFC 0002 PR-2 对齐）：
 *   (a) trigger='update' + session.tfa='verified' → 清 false（/login/2fa 成功路径）
 *   (b) DB 里 2FA 已被禁用 → 清 false（用户不会卡在质询页）
 *   (c) DB 里 2FA 启用 + token 上还没标过 → 设 true（防旧 token 绕过新启用的 2FA）
 *
 * 返回 `undefined` 表示「保持原值不动」，由调用方决定要不要写回。
 *
 * @param current               当前 token 上的 tfa_pending（可能 undefined）
 * @param freshTwoFactorEnabled DB 里 user.twoFactorEnabled 现值
 * @param trigger               Auth.js callback 触发器
 * @param sessionTfa            `unstable_update({ tfa: 'verified' })` 时附带的标记
 */
export function decideTfaPending(
  current: boolean | undefined,
  freshTwoFactorEnabled: boolean,
  trigger: JwtTrigger,
  sessionTfa: string | undefined,
): boolean | undefined {
  // (a) /login/2fa 成功路径：显式清掉 pending。
  if (trigger === 'update' && sessionTfa === 'verified') return false;
  // (b) 2FA 在会话中被关掉：清掉 pending，避免用户被卡在没有 2FA 的质询页。
  if (!freshTwoFactorEnabled) return false;
  // (c) 2FA 在会话中被打开但 token 上还没标过 → 设 true（pre-PR-2 token 路径）。
  if (current === undefined) return true;
  // 否则不动（已经是 true 等待 challenge，或已经是 false 表示已验证）。
  return undefined;
}
