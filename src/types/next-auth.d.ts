import 'next-auth';
import 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      role?: 'USER' | 'ADMIN';
    };
    /**
     * RFC 0002 PR-1: sha256(sid) for the current device session. Safe to
     * expose to the client — it's just a DB lookup key, can't be used to
     * forge a session. Server-side helpers compare against this to flag
     * the "current" row in the active-sessions UI.
     */
    sidHash?: string;
    /**
     * RFC 0002 PR-2: true while the user has 2FA enabled but hasn't yet
     * passed the TOTP challenge in the current session. Middleware /
     * RSC redirect such users to /login/2fa.
     */
    tfaPending?: boolean;
    /**
     * RFC 0002 PR-4: 'PENDING_DELETION' iff the user has scheduled their
     * account for deletion. Middleware funnels these users to the
     * cancel-deletion page; they can't do anything else until they
     * either cancel or the cron deletes them.
     */
    userStatus?: 'ACTIVE' | 'PENDING_DELETION';
    /**
     * RFC 0005: region the User row lives in. Stamped at sign-in from
     * `User.region` and compared against `currentRegion()` in middleware
     * — a mismatch (e.g. cookie smuggled across stacks) bounces to
     * `/region-mismatch`.
     */
    userRegion?: 'GLOBAL' | 'CN' | 'EU';
  }

  interface User {
    role?: 'USER' | 'ADMIN';
    sessionVersion?: number;
    twoFactorEnabled?: boolean;
    status?: 'ACTIVE' | 'PENDING_DELETION';
    region?: 'GLOBAL' | 'CN' | 'EU';
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string;
    role?: 'USER' | 'ADMIN';
    sessionVersion?: number;
    /** RFC 0002 PR-1: per-device session id; sha256(sid) lives in `DeviceSession`. */
    sid?: string;
    /** RFC 0002 PR-1: sha256(sid). Computed Node-side, copied into Session by the edge-safe session callback. */
    sidHash?: string;
    /** RFC 0002 PR-2: true between sign-in and a successful TOTP challenge. */
    tfa_pending?: boolean;
    /** RFC 0002 PR-4: account lifecycle state. */
    status?: 'ACTIVE' | 'PENDING_DELETION';
    /** RFC 0005: deploy region the User belongs to. */
    region?: 'GLOBAL' | 'CN' | 'EU';
  }
}
