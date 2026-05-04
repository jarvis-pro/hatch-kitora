import { authenticateScim, scimError, scimJson } from '@/services/sso/scim-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-4 / SCIM 2.0 §7 — Schemas 发现。
 *
 * 返回我们实现的静态 SCIM schemas：User + Group。没有
 * EnterpriseUser 扩展（经理/员工号等）— 那是后续领地，
 * 大多数 IdP 都对没有它感到满意。
 */
export async function GET(request: Request) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return scimError(auth.status, auth.reason);

  return scimJson(200, {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: 2,
    Resources: [USER_SCHEMA, GROUP_SCHEMA],
  });
}

const USER_SCHEMA = {
  id: 'urn:ietf:params:scim:schemas:core:2.0:User',
  name: 'User',
  description: 'User account on the Kitora platform.',
  attributes: [
    {
      name: 'userName',
      type: 'string',
      multiValued: false,
      required: true,
      uniqueness: 'server',
    },
    {
      name: 'name',
      type: 'complex',
      multiValued: false,
      required: false,
      subAttributes: [
        { name: 'familyName', type: 'string', multiValued: false, required: false },
        { name: 'givenName', type: 'string', multiValued: false, required: false },
      ],
    },
    {
      name: 'emails',
      type: 'complex',
      multiValued: true,
      required: false,
      subAttributes: [
        { name: 'value', type: 'string', multiValued: false, required: true },
        { name: 'primary', type: 'boolean', multiValued: false, required: false },
      ],
    },
    { name: 'active', type: 'boolean', multiValued: false, required: false },
    { name: 'externalId', type: 'string', multiValued: false, required: false },
  ],
  meta: {
    resourceType: 'Schema',
    location: '/api/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User',
  },
};

const GROUP_SCHEMA = {
  id: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  name: 'Group',
  description: 'Static role group — Owners / Admins / Members.',
  attributes: [
    { name: 'displayName', type: 'string', multiValued: false, required: true },
    {
      name: 'members',
      type: 'complex',
      multiValued: true,
      required: false,
      subAttributes: [
        { name: 'value', type: 'string', multiValued: false, required: true },
        { name: '$ref', type: 'reference', multiValued: false, required: false },
      ],
    },
  ],
  meta: {
    resourceType: 'Schema',
    location: '/api/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:Group',
  },
};
