// NOTE: deliberately *not* `'server-only'` here — server actions, route
// handlers, and (eventually) e2e fixtures all import this adapter. The
// transitive `@boxyhq/saml-jackson` import is Node-only.
//
// Thin sync layer between `IdentityProvider` rows and `@boxyhq/saml-jackson`
// connections. Jackson stores its own copy of the parsed SAML metadata /
// OIDC discovery payload in its `jackson_*` tables; we own the user-facing
// row in `IdentityProvider` and re-push to Jackson on every write so the
// two views never drift.
//
// Tenancy contract:
//
//   tenant  = organization slug (UTF-8, URL-safe)
//   product = JACKSON_PRODUCT (constant — single-product install)
//
// `getConnections({ tenant, product })` returns at most one SAML and one
// OIDC connection — Jackson allows N per (tenant, product) but our
// `IdentityProvider` `@@unique([orgId, protocol])` collapses that to two.

import { env } from '@/env';

import { JACKSON_PRODUCT, getConnectionController } from './jackson';

export interface SamlSyncInput {
  /** Organization slug — used as Jackson tenant. */
  orgSlug: string;
  /** Raw IdP metadata XML. */
  samlMetadata: string;
}

export interface OidcSyncInput {
  orgSlug: string;
  oidcIssuer: string;
  oidcClientId: string;
  /** Plaintext OIDC client_secret. Not persisted by Jackson in plaintext —
   *  Jackson encrypts at rest with its own key. We re-pass on every update. */
  oidcClientSecret: string;
}

function defaultRedirectUrl(): string {
  return `${env.NEXT_PUBLIC_APP_URL}/dashboard`;
}

function allowedRedirectUrls(): string {
  // Jackson expects a JSON-encoded array of allowed redirect-URI prefixes.
  // We only ever land back in our own app, so a single host is enough.
  return JSON.stringify([env.NEXT_PUBLIC_APP_URL]);
}

/**
 * Upsert a SAML connection. If a SAML row already exists for this tenant
 * we delete + recreate (Jackson's `updateSAMLConnection` requires the
 * pre-existing `clientID` + `clientSecret`, and we don't track those —
 * delete+create is idempotent and equally cheap).
 */
export async function syncSamlConnection(input: SamlSyncInput): Promise<void> {
  const ctrl = await getConnectionController();
  const existing = await ctrl.getConnections({
    tenant: input.orgSlug,
    product: JACKSON_PRODUCT,
  });
  // Drop any pre-existing SAML row(s) under the same tenant. Jackson keys
  // by clientID; passing the same metadata twice would create duplicates.
  // The (SAMLSSORecord | OIDCSSORecord) union has no shared `protocol`
  // field — discriminate by which record-shape field is set.
  for (const c of existing) {
    if ('idpMetadata' in c) {
      await ctrl.deleteConnections({
        clientID: c.clientID,
        clientSecret: c.clientSecret,
      });
    }
  }
  await ctrl.createSAMLConnection({
    rawMetadata: input.samlMetadata,
    defaultRedirectUrl: defaultRedirectUrl(),
    redirectUrl: allowedRedirectUrls(),
    tenant: input.orgSlug,
    product: JACKSON_PRODUCT,
  });
}

/**
 * Upsert an OIDC connection. Same delete+recreate pattern as
 * `syncSamlConnection` for the same reason.
 */
export async function syncOidcConnection(input: OidcSyncInput): Promise<void> {
  const ctrl = await getConnectionController();
  const existing = await ctrl.getConnections({
    tenant: input.orgSlug,
    product: JACKSON_PRODUCT,
  });
  for (const c of existing) {
    // OIDC record carries `oidcProvider`; SAML record doesn't.
    if ('oidcProvider' in c) {
      await ctrl.deleteConnections({
        clientID: c.clientID,
        clientSecret: c.clientSecret,
      });
    }
  }
  await ctrl.createOIDCConnection({
    oidcDiscoveryUrl: `${input.oidcIssuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
    oidcClientId: input.oidcClientId,
    oidcClientSecret: input.oidcClientSecret,
    defaultRedirectUrl: defaultRedirectUrl(),
    redirectUrl: allowedRedirectUrls(),
    tenant: input.orgSlug,
    product: JACKSON_PRODUCT,
  });
}

/** Remove every connection under a tenant — used on IdP delete + org delete. */
export async function removeConnections(orgSlug: string): Promise<void> {
  const ctrl = await getConnectionController();
  const existing = await ctrl.getConnections({
    tenant: orgSlug,
    product: JACKSON_PRODUCT,
  });
  for (const c of existing) {
    await ctrl.deleteConnections({
      clientID: c.clientID,
      clientSecret: c.clientSecret,
    });
  }
}
