import { handlers } from '@/lib/auth';

/**
 * NextAuth 动态路由处理器。
 *
 * 支持所有 NextAuth.js 认证流程，包括登录、登出、回调等。
 * 通过 `[...nextauth]` 动态捕获所有路由片段并转发至 NextAuth 核心逻辑。
 */
export const { GET, POST } = handlers;
