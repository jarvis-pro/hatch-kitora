/**
 * `'server-only'` 的 Vitest 替身。
 *
 * 真 `'server-only'` 包（npm: server-only）在被 React 当作 client-component
 * 上下文 import 时会抛 "This module cannot be imported from a Client Component
 * module"。Next.js 用它给 RSC / route handler 守边界 —— 任何意外被前端 bundle
 * 拉进去的 server lib 会在 build 时立即冒错。
 *
 * Vitest 没有 RSC 标记，看在它眼里就是客户端环境，于是任何 transitively 引到
 * `'server-only'` 的 lib（`auth/2fa-crypto.ts`、`api-org-gate.ts`、`stripe/*`
 * 等）都会被守门员拒之门外。`vitest.config.ts` 把 `'server-only'` alias 到
 * 这个空模块，让测试能直接 import 这些文件做单元测试。
 *
 * 这并不会让测试代码意外被前端 bundle —— Next.js 自己 build 时仍然走的是真包，
 * 守边界的功能完整保留；alias 仅作用于 vitest 进程。
 */
export {};
