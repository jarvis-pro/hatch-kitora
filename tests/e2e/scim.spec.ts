import { createOrgWithOwner, createTestUser, deleteOrg, deleteUser, prisma } from './fixtures/db';
import { expect, test } from '@playwright/test';

import { generateScimToken } from '../../src/lib/sso/secret';

/**
 * RFC 0004 PR-4 — SCIM e2e.
 *
 * Covers the slice of SCIM 2.0 that real IdP connectors actually drive:
 *
 *   1. Auth — Bearer + scim_<…> roundtrip.
 *   2. ServiceProviderConfig + Schemas discovery (IdP onboarding).
 *   3. Users CRUD — POST → GET filter → PATCH active → DELETE.
 *   4. Groups — list + PATCH-add member (role flip) + OWNER refusal.
 *
 * We skip Schemas/{id} and ResourceTypes/{id} discovery routes — most
 * IdPs only ever read the collection responses.
 */

test.describe('scim v2 (RFC 0004 PR-4)', () => {
  test('Bearer auth + Users + Groups full flow', async ({ request }) => {
    const owner = await createTestUser({ emailVerified: true });
    const slug = `scim-${Date.now()}`;
    const org = await createOrgWithOwner({ ownerId: owner.id, slug });

    const tokenSet = generateScimToken();
    const idp = await prisma.identityProvider.create({
      data: {
        orgId: org.id,
        name: 'SCIM E2E IdP',
        protocol: 'SAML',
        emailDomains: ['scim-e2e.example.com'],
        defaultRole: 'MEMBER',
        enabledAt: new Date(),
        samlMetadata: '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"/>',
        scimEnabled: true,
        scimTokenHash: tokenSet.hash,
        scimTokenPrefix: tokenSet.prefix,
      },
      select: { id: true },
    });

    const headers = { authorization: `Bearer ${tokenSet.plain}` };
    const badHeaders = { authorization: 'Bearer scim_not-a-real-token' };

    let provisionedUserId: string | null = null;
    let provisionedMembershipId: string | null = null;

    try {
      // ── 401 paths ────────────────────────────────────────────────────────
      const noAuth = await request.get('/api/scim/v2/Users');
      expect(noAuth.status()).toBe(401);

      const wrongAuth = await request.get('/api/scim/v2/Users', { headers: badHeaders });
      expect(wrongAuth.status()).toBe(401);

      // ── ServiceProviderConfig + Schemas ──────────────────────────────────
      const cfg = await request.get('/api/scim/v2/ServiceProviderConfig', { headers });
      expect(cfg.status()).toBe(200);
      const cfgBody = await cfg.json();
      expect(cfgBody.patch.supported).toBe(true);
      expect(cfgBody.bulk.supported).toBe(false);

      const schemas = await request.get('/api/scim/v2/Schemas', { headers });
      expect(schemas.status()).toBe(200);
      const schemasBody = await schemas.json();
      expect(schemasBody.totalResults).toBe(2);
      expect(schemasBody.Resources.map((r: { id: string }) => r.id)).toContain(
        'urn:ietf:params:scim:schemas:core:2.0:User',
      );

      // ── POST User ────────────────────────────────────────────────────────
      const userName = `jane+${Date.now()}@scim-e2e.example.com`;
      const post = await request.post('/api/scim/v2/Users', {
        headers: { ...headers, 'content-type': 'application/scim+json' },
        data: {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName,
          externalId: 'scim-ext-123',
          name: { givenName: 'Jane', familyName: 'Doe' },
          emails: [{ value: userName, primary: true }],
          active: true,
        },
      });
      expect(post.status()).toBe(201);
      const created = await post.json();
      expect(created.userName).toBe(userName);
      expect(created.active).toBe(true);
      expect(created.externalId).toBe('scim-ext-123');
      expect(created.id).toBeTruthy();
      provisionedMembershipId = created.id;

      // Resolve userId for cleanup later.
      const m = await prisma.membership.findUniqueOrThrow({
        where: { id: provisionedMembershipId! },
        select: { userId: true },
      });
      provisionedUserId = m.userId;

      // ── GET Users with userName eq filter ────────────────────────────────
      // encodeURIComponent so `+` in the email survives the query-string
      // round-trip (URL parser would otherwise decode it to a space).
      const list = await request.get(
        `/api/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${userName}"`)}`,
        { headers },
      );
      expect(list.status()).toBe(200);
      const listBody = await list.json();
      expect(listBody.totalResults).toBe(1);
      expect(listBody.Resources[0].id).toBe(provisionedMembershipId);

      // ── PATCH active = false → soft-delete (deletedAt set) ───────────────
      const patchActive = await request.patch(`/api/scim/v2/Users/${provisionedMembershipId}`, {
        headers: { ...headers, 'content-type': 'application/scim+json' },
        data: {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        },
      });
      expect(patchActive.status()).toBe(200);
      const patched = await patchActive.json();
      expect(patched.active).toBe(false);

      const dbAfterSoft = await prisma.membership.findUniqueOrThrow({
        where: { id: provisionedMembershipId! },
        select: { deletedAt: true },
      });
      expect(dbAfterSoft.deletedAt).not.toBeNull();

      // ── PATCH groups → role=ADMIN ────────────────────────────────────────
      const patchAdmin = await request.patch(`/api/scim/v2/Users/${provisionedMembershipId}`, {
        headers: { ...headers, 'content-type': 'application/scim+json' },
        data: {
          Operations: [
            { op: 'replace', path: 'active', value: true },
            { op: 'replace', path: 'groups', value: [{ value: 'admins' }] },
          ],
        },
      });
      expect(patchAdmin.status()).toBe(200);
      const dbAdmin = await prisma.membership.findUniqueOrThrow({
        where: { id: provisionedMembershipId! },
        select: { role: true, deletedAt: true },
      });
      expect(dbAdmin.role).toBe('ADMIN');
      expect(dbAdmin.deletedAt).toBeNull();

      // ── PATCH groups → OWNER refused ─────────────────────────────────────
      const refusedOwner = await request.patch(`/api/scim/v2/Users/${provisionedMembershipId}`, {
        headers: { ...headers, 'content-type': 'application/scim+json' },
        data: {
          Operations: [{ op: 'replace', path: 'groups', value: [{ value: 'owners' }] }],
        },
      });
      expect(refusedOwner.status()).toBe(400);
      const refusedBody = await refusedOwner.json();
      expect(refusedBody.scimType).toBe('noTarget');

      // ── Groups list ─────────────────────────────────────────────────────
      const groupsList = await request.get('/api/scim/v2/Groups', { headers });
      expect(groupsList.status()).toBe(200);
      const gl = await groupsList.json();
      expect(gl.totalResults).toBe(3);
      const ids = gl.Resources.map((r: { id: string }) => r.id);
      expect(ids).toEqual(expect.arrayContaining(['owner', 'admin', 'member']));

      // ── Group → demote via member remove ────────────────────────────────
      const demote = await request.patch('/api/scim/v2/Groups/admin', {
        headers: { ...headers, 'content-type': 'application/scim+json' },
        data: {
          Operations: [{ op: 'remove', path: `members[value eq "${provisionedMembershipId}"]` }],
        },
      });
      expect(demote.status()).toBe(200);
      const dbDemoted = await prisma.membership.findUniqueOrThrow({
        where: { id: provisionedMembershipId! },
        select: { role: true },
      });
      expect(dbDemoted.role).toBe('MEMBER');

      // ── DELETE → hard-delete the Membership row ─────────────────────────
      const del = await request.delete(`/api/scim/v2/Users/${provisionedMembershipId}`, {
        headers,
      });
      expect(del.status()).toBe(204);
      const after = await prisma.membership.findUnique({
        where: { id: provisionedMembershipId! },
      });
      expect(after).toBeNull();
      provisionedMembershipId = null;
    } finally {
      if (provisionedMembershipId) {
        await prisma.membership
          .delete({ where: { id: provisionedMembershipId } })
          .catch(() => undefined);
      }
      if (provisionedUserId) {
        await deleteUser(provisionedUserId).catch(() => undefined);
      }
      // IdentityProvider cascades on Org delete.
      void idp;
      await deleteOrg(org.id).catch(() => undefined);
      await deleteUser(owner.id).catch(() => undefined);
    }
  });
});
