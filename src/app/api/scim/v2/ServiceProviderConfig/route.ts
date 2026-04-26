import { authenticateScim, scimError, scimJson } from '@/lib/sso/scim-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-4 / SCIM 2.0 §4 — ServiceProviderConfig.
 *
 * Standard discovery endpoint: most IdP-side SCIM connectors call this
 * before doing anything else to find out what filters / PATCH ops we
 * support. We're conservative — `eq` filter on `userName`, no bulk, no
 * change-password (everything goes through the IdP), supports PATCH per
 * RFC 7644 §3.5.2.
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
