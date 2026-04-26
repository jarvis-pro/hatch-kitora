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
  }

  interface User {
    role?: 'USER' | 'ADMIN';
    sessionVersion?: number;
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
  }
}
