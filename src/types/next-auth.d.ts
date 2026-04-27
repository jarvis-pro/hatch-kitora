import 'next-auth';
import 'next-auth/jwt';

/**
 * Auth.js (next-auth) Session 和 User 类型扩展。
 *
 * 定义应用特定的会话和用户元数据，包括权限、设备会话、
 * 双因素认证状态、账户生命周期和多地区支持。
 */
declare module 'next-auth' {
  /**
   * 扩展的会话接口，包含应用级业务数据。
   */
  interface Session {
    /**
     * 用户基本信息。
     */
    user: {
      /**
       * 用户在数据库中的唯一标识符。
       */
      id: string;
      /**
       * 用户显示名称。
       */
      name?: string | null;
      /**
       * 用户电子邮件地址。
       */
      email?: string | null;
      /**
       * 用户头像 URL。
       */
      image?: string | null;
      /**
       * 用户角色：'USER' 为普通用户，'ADMIN' 为管理员。
       */
      role?: 'USER' | 'ADMIN';
    };
    /**
     * RFC 0002 PR-1: 当前设备会话的 sha256(sid) 哈希值。
     * 可安全暴露给客户端——仅是数据库查询键，无法伪造会话。
     * 服务端在活跃会话 UI 中用此值标记"当前"行。
     */
    sidHash?: string;
    /**
     * RFC 0002 PR-2: 当用户已启用 2FA 但尚未在当前会话中
     * 通过 TOTP 验证时为 true。中间件 / RSC 将这些用户重定向到 /login/2fa。
     */
    tfaPending?: boolean;
    /**
     * RFC 0002 PR-4: 用户账户状态。'PENDING_DELETION' 表示用户
     * 已安排删除其账户。中间件将这些用户漏斗到取消删除页面；
     * 在取消或 cron 任务删除前，他们无法进行其他操作。
     */
    userStatus?: 'ACTIVE' | 'PENDING_DELETION';
    /**
     * RFC 0005: 用户所在部署区域。在登录时从 `User.region` 记录，
     * 在中间件中与 `currentRegion()` 对比——若不匹配
     * （如 cookie 被走私到其他堆栈），则重定向到 `/region-mismatch`。
     */
    userRegion?: 'GLOBAL' | 'CN' | 'EU';
  }

  /**
   * 扩展的用户接口，包含认证元数据。
   */
  interface User {
    /**
     * 用户角色：'USER' 为普通用户，'ADMIN' 为管理员。
     */
    role?: 'USER' | 'ADMIN';
    /**
     * 会话版本号，用于在密钥更改时强制重新认证。
     */
    sessionVersion?: number;
    /**
     * 用户是否启用了两因素认证。
     */
    twoFactorEnabled?: boolean;
    /**
     * 账户生命周期状态：'ACTIVE' 为活跃，'PENDING_DELETION' 为待删除。
     */
    status?: 'ACTIVE' | 'PENDING_DELETION';
    /**
     * 用户所在部署区域。
     */
    region?: 'GLOBAL' | 'CN' | 'EU';
  }
}

/**
 * Auth.js JWT 令牌类型扩展。
 *
 * JWT 中携带的用户信息，在签名和加密后存储在安全 cookie 中。
 */
declare module 'next-auth/jwt' {
  /**
   * 扩展的 JWT 接口，包含应用级声明。
   */
  interface JWT {
    /**
     * 用户在数据库中的唯一标识符。
     */
    id?: string;
    /**
     * 用户角色：'USER' 或 'ADMIN'。
     */
    role?: 'USER' | 'ADMIN';
    /**
     * 会话版本号，用于强制重新认证。
     */
    sessionVersion?: number;
    /**
     * RFC 0002 PR-1: 每个设备的会话 ID（来自 `DeviceSession` 表）。
     */
    sid?: string;
    /**
     * RFC 0002 PR-1: sid 的 sha256 哈希值。在 Node 端计算，
     * 由边缘安全的会话回调复制到 Session 对象中。
     */
    sidHash?: string;
    /**
     * RFC 0002 PR-2: 登录和成功通过 TOTP 验证间的过渡状态，为 true。
     */
    tfa_pending?: boolean;
    /**
     * RFC 0002 PR-4: 账户生命周期状态。
     */
    status?: 'ACTIVE' | 'PENDING_DELETION';
    /**
     * RFC 0005: 用户所属部署区域。
     */
    region?: 'GLOBAL' | 'CN' | 'EU';
  }
}
