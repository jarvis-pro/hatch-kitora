'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  createIdentityProviderAction,
  deleteIdentityProviderAction,
  rotateScimTokenAction,
  updateIdentityProviderAction,
} from '@/lib/orgs/identity-providers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

type Protocol = 'SAML' | 'OIDC';
type DefaultRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface SsoProviderRow {
  id: string;
  name: string;
  protocol: Protocol;
  emailDomains: string[];
  defaultRole: DefaultRole;
  enforceForLogin: boolean;
  enabledAt: string | null;
  scimEnabled: boolean;
  scimTokenPrefix: string | null;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  orgSlug: string;
  /** OWNER can flip enforceForLogin; ADMIN cannot. */
  isOwner: boolean;
  providers: SsoProviderRow[];
}

/**
 * RFC 0004 PR-1 — IdP list + add form + per-row inline edit + SCIM token
 * reveal-once modal. Hard cap of 2 rows per org (1 SAML + 1 OIDC) is
 * enforced server-side via the `@@unique([orgId, protocol])` constraint;
 * the UI just hides the "Add" button for the protocol that's already
 * configured.
 */
export function SsoProviders({ orgSlug, isOwner, providers }: Props) {
  const t = useTranslations('orgs.sso');
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const haveSaml = providers.some((p) => p.protocol === 'SAML');
  const haveOidc = providers.some((p) => p.protocol === 'OIDC');

  // ─── Add form state ──────────────────────────────────────────────────────
  const [addProtocol, setAddProtocol] = useState<Protocol | null>(null);
  const [name, setName] = useState('');
  const [domains, setDomains] = useState('');
  const [samlMetadata, setSamlMetadata] = useState('');
  const [oidcIssuer, setOidcIssuer] = useState('');
  const [oidcClientId, setOidcClientId] = useState('');
  const [oidcClientSecret, setOidcClientSecret] = useState('');
  const [enforce, setEnforce] = useState(false);

  // ─── SCIM reveal modal ───────────────────────────────────────────────────
  const [revealed, setRevealed] = useState<{ token: string } | null>(null);

  const reset = () => {
    setAddProtocol(null);
    setName('');
    setDomains('');
    setSamlMetadata('');
    setOidcIssuer('');
    setOidcClientId('');
    setOidcClientSecret('');
    setEnforce(false);
  };

  const onCreate = () => {
    if (!addProtocol) return;
    startTransition(async () => {
      const emailDomains = domains
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const result = await createIdentityProviderAction({
        orgSlug,
        protocol: addProtocol,
        name: name.trim() || addProtocol,
        emailDomains,
        defaultRole: 'MEMBER',
        enforceForLogin: enforce,
        samlMetadata: addProtocol === 'SAML' ? samlMetadata : undefined,
        oidcIssuer: addProtocol === 'OIDC' ? oidcIssuer.trim() : undefined,
        oidcClientId: addProtocol === 'OIDC' ? oidcClientId.trim() : undefined,
        oidcClientSecret: addProtocol === 'OIDC' ? oidcClientSecret : undefined,
      });
      if (!result.ok) {
        toast.error(mapErr(t, result.error));
        return;
      }
      toast.success(t('actions.created'));
      reset();
      router.refresh();
    });
  };

  const onDelete = (id: string) => {
    if (!confirm(t('actions.deleteConfirm'))) return;
    startTransition(async () => {
      const result = await deleteIdentityProviderAction({ orgSlug, id });
      if (result.ok) {
        toast.success(t('actions.deleted'));
        router.refresh();
      } else {
        toast.error(mapErr(t, result.error));
      }
    });
  };

  const onToggleEnforce = (p: SsoProviderRow) => {
    if (!isOwner) return;
    startTransition(async () => {
      const result = await updateIdentityProviderAction({
        orgSlug,
        id: p.id,
        enforceForLogin: !p.enforceForLogin,
      });
      if (result.ok) {
        toast.success(t('actions.updated'));
        router.refresh();
      } else {
        toast.error(mapErr(t, result.error));
      }
    });
  };

  const onToggleEnabled = (p: SsoProviderRow) => {
    startTransition(async () => {
      const result = await updateIdentityProviderAction({
        orgSlug,
        id: p.id,
        enabledAt: p.enabledAt ? null : new Date(),
      });
      if (result.ok) {
        toast.success(t('actions.updated'));
        router.refresh();
      } else {
        toast.error(mapErr(t, result.error));
      }
    });
  };

  const onRotateScim = (id: string) => {
    if (!confirm(t('actions.rotateScimConfirm'))) return;
    startTransition(async () => {
      const result = await rotateScimTokenAction({ orgSlug, id });
      if (result.ok) {
        setRevealed({ token: result.token });
        router.refresh();
      } else {
        toast.error(mapErr(t, result.error));
      }
    });
  };

  const onCopy = async (raw: string) => {
    try {
      await navigator.clipboard.writeText(raw);
      toast.success(t('scim.revealed.copy'));
    } catch {
      // Clipboard may fail silently in some contexts — non-fatal.
    }
  };

  return (
    <div className="space-y-6">
      {/* SCIM token reveal-once banner */}
      {revealed ? (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {t('scim.revealed.title')}
          </p>
          <p className="text-xs text-amber-700/80 dark:text-amber-400/80">
            {t('scim.revealed.body')}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md bg-background px-3 py-2 font-mono text-xs">
              {revealed.token}
            </code>
            <Button size="sm" variant="outline" onClick={() => onCopy(revealed.token)}>
              {t('scim.revealed.copy')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>
              {t('scim.revealed.ack')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Provider list */}
      {providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {providers.map((p) => (
            <li key={p.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">
                      {p.protocol}
                    </span>
                    <strong className="text-sm">{p.name}</strong>
                    <span
                      className={
                        p.enabledAt
                          ? 'rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700'
                          : 'rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground'
                      }
                    >
                      {p.enabledAt ? t('status.enabled') : t('status.draft')}
                    </span>
                    {p.enforceForLogin ? (
                      <span className="rounded bg-blue-500/10 px-2 py-0.5 text-xs text-blue-700">
                        {t('status.enforced')}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {p.emailDomains.length > 0 ? p.emailDomains.join(', ') : t('table.noDomains')} ·{' '}
                    {t('table.role')}: {p.defaultRole} ·{' '}
                    {format.dateTime(new Date(p.createdAt), { dateStyle: 'short' })}
                  </p>
                  {p.protocol === 'OIDC' && p.oidcIssuer ? (
                    <p className="text-xs text-muted-foreground">
                      <code className="font-mono">{p.oidcIssuer}</code>
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {t('scim.label')}:{' '}
                    {p.scimTokenPrefix ? (
                      <code className="font-mono">scim_{p.scimTokenPrefix}…</code>
                    ) : (
                      <em>{t('scim.none')}</em>
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => onToggleEnabled(p)}
                  >
                    {p.enabledAt ? t('actions.disable') : t('actions.enable')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending || !isOwner}
                    title={!isOwner ? t('errors.enforceOwnerOnly') : undefined}
                    onClick={() => onToggleEnforce(p)}
                  >
                    {p.enforceForLogin ? t('actions.unenforce') : t('actions.enforce')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => onRotateScim(p.id)}
                  >
                    {p.scimTokenPrefix ? t('actions.rotateScim') : t('actions.generateScim')}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={pending}
                    onClick={() => onDelete(p.id)}
                  >
                    {t('actions.delete')}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Add provider section */}
      <div className="space-y-3 rounded-md border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t('add.title')}</h3>
          <div className="flex gap-2">
            <Button
              variant={addProtocol === 'SAML' ? 'default' : 'outline'}
              size="sm"
              disabled={haveSaml || pending}
              onClick={() => setAddProtocol('SAML')}
            >
              {t('add.saml')}
            </Button>
            <Button
              variant={addProtocol === 'OIDC' ? 'default' : 'outline'}
              size="sm"
              disabled={haveOidc || pending}
              onClick={() => setAddProtocol('OIDC')}
            >
              {t('add.oidc')}
            </Button>
          </div>
        </div>

        {addProtocol === null ? (
          <p className="text-sm text-muted-foreground">
            {haveSaml && haveOidc ? t('add.maxedOut') : t('add.pickProtocol')}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="sso-name">{t('fields.name')}</Label>
              <Input
                id="sso-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('fields.namePlaceholder')}
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sso-domains">{t('fields.emailDomains')}</Label>
              <Input
                id="sso-domains"
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
                placeholder="acme.com, acme.io"
              />
              <p className="text-xs text-muted-foreground">{t('fields.emailDomainsHint')}</p>
            </div>

            {addProtocol === 'SAML' ? (
              <div className="space-y-2">
                <Label htmlFor="sso-saml">{t('fields.samlMetadata')}</Label>
                <textarea
                  id="sso-saml"
                  value={samlMetadata}
                  onChange={(e) => setSamlMetadata(e.target.value)}
                  rows={6}
                  className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                  placeholder="<EntityDescriptor xmlns=...>"
                />
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="sso-issuer">{t('fields.oidcIssuer')}</Label>
                  <Input
                    id="sso-issuer"
                    value={oidcIssuer}
                    onChange={(e) => setOidcIssuer(e.target.value)}
                    placeholder="https://accounts.example.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sso-client-id">{t('fields.oidcClientId')}</Label>
                  <Input
                    id="sso-client-id"
                    value={oidcClientId}
                    onChange={(e) => setOidcClientId(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sso-client-secret">{t('fields.oidcClientSecret')}</Label>
                  <Input
                    id="sso-client-secret"
                    type="password"
                    value={oidcClientSecret}
                    onChange={(e) => setOidcClientSecret(e.target.value)}
                  />
                </div>
              </>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enforce}
                disabled={!isOwner}
                onChange={(e) => setEnforce(e.target.checked)}
              />
              <span>
                {t('fields.enforce')}
                {!isOwner ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({t('errors.enforceOwnerOnly')})
                  </span>
                ) : null}
              </span>
            </label>

            <div className="flex gap-2">
              <Button onClick={onCreate} disabled={pending || !name.trim()}>
                {pending ? t('add.creating') : t('add.create')}
              </Button>
              <Button variant="ghost" onClick={reset} disabled={pending}>
                {t('add.cancel')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function mapErr(t: ReturnType<typeof useTranslations>, code: string): string {
  if (code.startsWith('invalid-domain:')) {
    return t('errors.invalidDomain');
  }
  const map: Record<string, string> = {
    'enforce-owner-only': t('errors.enforceOwnerOnly'),
    'enforce-still-on': t('errors.enforceStillOn'),
    'saml-metadata-required': t('errors.samlMetadataRequired'),
    'oidc-fields-required': t('errors.oidcFieldsRequired'),
    forbidden: t('errors.forbidden'),
    'not-found': t('errors.notFound'),
    'invalid-input': t('errors.generic'),
  };
  return map[code] ?? t('errors.generic');
}
