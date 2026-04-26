// NOTE: deliberately *not* `'server-only'` here — Playwright e2e tests
// drive the SSO login flow in-process (mock IdP response → ACS → session
// write) and need to import this adapter. Jackson itself is Node-only via
// its sql `engine` config so client bundling will fail loud anyway.
//
// Singleton wrapper around `@boxyhq/saml-jackson`. The library exposes a
// rich set of controllers — we only need a slice for SSO login:
//
//   - `apiController`     — manage SAML / OIDC connections (one per IdP row).
//   - `oauthController`   — OAuth-style authorize / token / userinfo flow
//                           that bridges the SAML AuthnResponse into a
//                           code → access-token → profile that we can plug
//                           into Auth.js.
//
// Tenancy:
//
//   tenant  = organization slug (one IdP per tenant per protocol)
//   product = "kitora" (constant — Jackson supports multi-product but we
//             only have one)
//
// The library auto-creates its own tables under `jackson_*` prefix on
// first `init()`, sharing our PG database via the `engine: 'sql'` config.

import jackson, {
  type IConnectionAPIController,
  type IOAuthController,
  type JacksonOption,
} from '@boxyhq/saml-jackson';

import { env } from '@/env';

/**
 * `tenant` value passed to Jackson for every IdP we register. We use the
 * org's `slug` because it's URL-safe and stable; rotating it would only
 * happen alongside an explicit org rename, which is rare.
 */
export const JACKSON_PRODUCT = 'kitora' as const;

const samlPath = '/api/auth/sso/saml/acs';
const oidcPath = '/api/auth/sso/oidc/callback';

let cached: Promise<{
  apiController: IConnectionAPIController;
  oauthController: IOAuthController;
}> | null = null;

/** Lazy init — first caller bootstraps Jackson + creates `jackson_*` tables. */
export function getJackson(): Promise<{
  apiController: IConnectionAPIController;
  oauthController: IOAuthController;
}> {
  if (cached) return cached;

  const opts: JacksonOption = {
    externalUrl: env.NEXT_PUBLIC_APP_URL,
    samlAudience: env.NEXT_PUBLIC_APP_URL,
    samlPath,
    oidcPath,
    db: {
      engine: 'sql',
      type: 'postgres',
      url: env.DATABASE_URL,
      // ttl: undefined → Jackson default (300s) for transient sessions
      cleanupLimit: 1000,
    },
  };

  cached = jackson(opts).then((ret) => ({
    apiController: ret.apiController,
    oauthController: ret.oauthController,
  }));
  return cached;
}

/** Convenience for routes that only need the OAuth slice. */
export async function getOauthController(): Promise<IOAuthController> {
  const { oauthController } = await getJackson();
  return oauthController;
}

/** Convenience for IdP CRUD plumbing. */
export async function getConnectionController(): Promise<IConnectionAPIController> {
  const { apiController } = await getJackson();
  return apiController;
}
