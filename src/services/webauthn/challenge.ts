// RFC 0007 PR-1 — 临时 WebAuthn 质询存储。
//
// 每个注册/身份验证仪式都从服务器生成的 32 字节随机质询开始。
// 浏览器将其包含（由身份验证器签署）在响应中；服务器进行交叉检查。
// 此模块是生成和使用质询的唯一正式位置。
//
// 存储策略：我们不使用单独的 `WebAuthnChallenge` 表，而是占用
// `User` 表的两列（`webauthnChallenge` + `webauthnChallengeAt`）。
// 权衡：
//
//   优点：少一个表，少一个迁移，少一个清理 cron；
//         每个用户每次只能进行一个仪式，
//         这与现实相符（同一账户不能同时在两个浏览器中登录）。
//   缺点：如果用户在标签页 A 开始一个仪式，然后打开标签页 B 并
//         启动另一个，标签页 A 的质询会被覆盖，标签页 A 的仪式
//         在验证时会失败。被认为是可接受的——仅是用户体验问题，
//         不是安全问题。
//
// 生活时间为 5 分钟 (TTL_MS)。`consumeChallenge` 在读取时进行
// 过期检查；过期的质询与"没有质询进行中"完全相同
// （两者都返回 `null`）。

import 'server-only';

import { randomBytes } from 'node:crypto';

import { prisma } from '@/lib/db';

const TTL_MS = 5 * 60 * 1000;

/**
 * 为 `userId` 生成并持久化一个新质询。覆盖同一用户的任何
 * 现有进行中的质询。
 */
export async function mintChallenge(userId: string): Promise<string> {
  const challenge = randomBytes(32).toString('base64url');
  await prisma.user.update({
    where: { id: userId },
    data: {
      webauthnChallenge: challenge,
      webauthnChallengeAt: new Date(),
    },
  });
  return challenge;
}

/**
 * 读取并清除 `userId` 的质询。如果没有质询进行中，或
 * 质询超过 `TTL_MS`，返回 `null`。
 *
 * 总是清除行的质询字段，即使是无操作读取——这样攻击者
 * 不能通过调用 consume 两次来重放过期的质询。
 */
export async function consumeChallenge(userId: string): Promise<string | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { webauthnChallenge: true, webauthnChallengeAt: true },
  });
  // 总是清除——即使没有要消费的内容也是防御性的。
  if (row?.webauthnChallenge) {
    await prisma.user.update({
      where: { id: userId },
      data: { webauthnChallenge: null, webauthnChallengeAt: null },
    });
  }
  if (!row?.webauthnChallenge || !row.webauthnChallengeAt) return null;
  const ageMs = Date.now() - row.webauthnChallengeAt.getTime();
  if (ageMs > TTL_MS) return null;
  return row.webauthnChallenge;
}

/**
 * 对于可发现的 / 无用户名登录流程，我们还不知道哪个用户正在
 * 登录——我们生成一个由不透明的服务器生成的会话 ID 键入的质询，
 * 该 ID 藏在响应 cookie 中，而不是由 userId 键入。这个存根
 * 在这里，以便 PR-4 可以添加一个 `mintAnonymousChallenge` 实现，
 * 而不需要接触已经使用 userId 键入路径的调用站点。
 *
 * @internal 仅 PR-4 无密码路由到达此处。
 */
export async function __anonymousChallengeStubForPR4(): Promise<never> {
  throw new Error('webauthn-anonymous-challenge-not-yet-implemented (RFC 0007 PR-4)');
}
