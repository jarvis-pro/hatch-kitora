// RFC 0007 PR-1 — WebAuthn 依赖方配置。
//
// 在任何仪式发生前需要确定的三个值：
//
//   * RP ID  — 凭据绑定的 eTLD+1。必须与页面主机名匹配；
//              不匹配的源 → 浏览器拒绝签署。在生产环境中，
//              我们按地区设置 `WEBAUTHN_RP_ID`（kitora.io / kitora.cn / kitora.eu）；
//              在开发 / e2e 中，我们回退到 `NEXT_PUBLIC_APP_URL` 的主机名
//              （通常是 `localhost`）。
//
//   * RP Name — OS/浏览器在同意提示中显示的人类可读标签
//              （"登录 Kitora"）。默认为 `Kitora`；
//              可通过 `WEBAUTHN_RP_NAME` 覆盖。
//
//   * Origin  — SimpleWebAuthn 验证助手交叉检查的完整源
//              （scheme + host + port）。我们直接从
//              `NEXT_PUBLIC_APP_URL` 派生它；设置显式的
//              `WEBAUTHN_ORIGIN` 很少需要，但支持奇怪的
//              反向代理设置。

import 'server-only';

import { env } from '@/env';

/**
 * WebAuthn 协议绑定凭据的 `id`。必须等于文档主机名
 * （或它的可注册后缀）。我们不进行规范化——如果有人设置
 * `WEBAUTHN_RP_ID=https://...` 那是一个配置错误，我们希望
 * 在第一个仪式时大声显示。
 */
export function getRpId(): string {
  if (env.WEBAUTHN_RP_ID) return env.WEBAUTHN_RP_ID;
  // 回退：从 NEXT_PUBLIC_APP_URL 拉取主机名。URL 解析器移除
  // scheme + port，留下裸主机（`kitora.io` 或 `localhost`）。
  return new URL(env.NEXT_PUBLIC_APP_URL).hostname;
}

/** 在 OS/浏览器同意提示中显示的人类可读 RP 名称。*/
export function getRpName(): string {
  return env.WEBAUTHN_RP_NAME ?? 'Kitora';
}

/**
 * SimpleWebAuthn 验证助手的预期源。包括 scheme + port；
 * SimpleWebAuthn 将其交叉检查与客户端的 `clientDataJSON.origin`
 * 字段。
 */
export function getOrigin(): string {
  if (env.WEBAUTHN_ORIGIN) return env.WEBAUTHN_ORIGIN;
  return env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
}
