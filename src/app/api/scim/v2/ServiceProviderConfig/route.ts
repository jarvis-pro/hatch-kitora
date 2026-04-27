import { authenticateScim, scimError, scimJson } from '@/lib/sso/scim-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-4 / SCIM 2.0 §4 — ServiceProviderConfig。
 *
 * 标准发现端点：大多数 IdP 端 SCIM 连接器会在执行任何操作前先调用此接口，
 * 以了解我们支持哪些过滤器和 PATCH 操作。我们采取保守策略 ——
 * 仅支持 `userName` 的 `eq` 过滤，不支持 bulk，不支持修改密码
 * （一切均通过 IdP），按 RFC 7644 §3.5.2 支持 PATCH。
 */
export async function GET(request: Request) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return scimError(auth.status, auth.reason);

  return scimJson(200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://kitora.example.com/docs/api#tag/SSO',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        name: 'OAuth Bearer Token',
        description:
          'Per-IdP token issued from /settings/organization/sso. Format: `scim_<base64url(32)>`.',
        specUri: 'https://datatracker.ietf.org/doc/html/rfc6750',
        type: 'oauthbearertoken',
        primary: true,
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig' },
  });
}
