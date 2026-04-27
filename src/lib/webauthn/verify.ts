// RFC 0007 PR-1 — 围绕 `@simplewebauthn/server` 的验证包装器。
//
// 两个验证操作：
//
//   * verifyRegistration  — 在 navigator.credentials.create() 后由
//                           `/register/verify` 路由调用。生成新凭据行的数据。
//   * verifyAuthentication — 在 navigator.credentials.get() 后由
//                           `/authenticate/verify` 调用。根据现有
//                           存储的凭据重新验证，更新其计数器 / lastUsedAt。
//
// 两者都将 SimpleWebAuthn 助手包装在部署区域感知的源 / RP ID 配置中，
// 以便调用站点不需要自己导入 config.ts。错误被规范化为 `null`-on-fail，
// 以便路由处理程序可以在 truthy/falsy 上分支，而不需要 try/catch 蔓延。

import 'server-only';

import type * as SimpleWebAuthnServer from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

import { logger } from '@/lib/logger';

import { getOrigin, getRpId } from './config';

// ─── 懒初始化 SDK ─────────────────────────────────────────────────────────
//
// SimpleWebAuthn 使用 `import { ... }` 命名导出来传输 ESM；
// 动态导入将模块保持在边缘包之外 + 使升级时的破坏更易于本地化
// （RFC 0006 PR-3 在 alipay-sdk / wechatpay-node-v3 上处理类似的 SDK 类型漂移）。

let _sdk: typeof SimpleWebAuthnServer | null = null;

async function getSdk(): Promise<typeof SimpleWebAuthnServer> {
  if (_sdk) return _sdk;
  _sdk = await import('@simplewebauthn/server');
  return _sdk;
}

// ─── 注册验证 ─────────────────────────────────────────────────────────

export interface VerifyRegistrationInput {
  response: RegistrationResponseJSON;
  /** 在 /register/options 时生成的质询，通过 `consumeChallenge` 返回。*/
  expectedChallenge: string;
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  /** 身份验证器报告的传输——如果没有则为空数组。*/
  transports: string[];
  /** 'singleDevice'（设备绑定）或 'multiDevice'（同步密钥）。*/
  deviceType: 'singleDevice' | 'multiDevice';
  /** AuthenticatorData BE 标志——当且仅当凭据是云备份时为真。*/
  backedUp: boolean;
}

/**
 * 验证注册响应。任何失败都返回 null，以便路由处理程序可以用 4xx
 * 短路，而无需重新抛出。
 */
export async function verifyRegistration(
  input: VerifyRegistrationInput,
): Promise<VerifiedRegistration | null> {
  const sdk = await getSdk();
  try {
    const result = await sdk.verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: getOrigin(),
      expectedRPID: getRpId(),
      // 我们不固定证明：'none' 是默认值，对于 v1，我们不需要
      // 经认证的供应商限制（RFC 0007 §1）。
      requireUserVerification: false,
    });

    if (!result.verified || !result.registrationInfo) {
      logger.warn({ result }, 'webauthn-register-verify-failed');
      return null;
    }

    const info = result.registrationInfo;
    return {
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    };
  } catch (error) {
    logger.warn({ err: error }, 'webauthn-register-verify-throw');
    return null;
  }
}

// ─── 身份验证验证 ────────────────────────────────────────────────────────────

export interface VerifyAuthenticationInput {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  /** 此断言声称来自的存储凭据行。*/
  credential: {
    id: string; // base64url credentialId
    publicKey: Buffer;
    counter: number;
    transports: string[];
  };
}

export interface VerifiedAuthentication {
  /** 身份验证器报告的新计数器——调用方持久化它。*/
  newCounter: number;
}

/**
 * 根据存储的凭据验证身份验证响应。任何失败都返回 null
 * （签名不匹配、重放、过期质询、源不匹配）。
 */
export async function verifyAuthentication(
  input: VerifyAuthenticationInput,
): Promise<VerifiedAuthentication | null> {
  const sdk = await getSdk();
  try {
    // SimpleWebAuthn v13 声明 `publicKey: Uint8Array<ArrayBuffer>`。
    // Node 的 `Buffer` 技术上是 `Uint8Array<ArrayBufferLike>`（包括 SharedArrayBuffer）
    // ——在严格模式下 TS 拒绝分配。通过复制基础字节重新包装为
    // 纯 Uint8Array<ArrayBuffer>；新数组的 .buffer 保证是真实的 ArrayBuffer。
    const publicKey = new Uint8Array(input.credential.publicKey);

    const result = await sdk.verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: getOrigin(),
      expectedRPID: getRpId(),
      credential: {
        id: input.credential.id,
        publicKey,
        counter: input.credential.counter,
        transports: input.credential.transports as never,
      },
      requireUserVerification: false,
    });

    if (!result.verified) {
      logger.warn({ verified: false }, 'webauthn-auth-verify-failed');
      return null;
    }

    return { newCounter: result.authenticationInfo.newCounter };
  } catch (error) {
    logger.warn({ err: error }, 'webauthn-auth-verify-throw');
    return null;
  }
}
