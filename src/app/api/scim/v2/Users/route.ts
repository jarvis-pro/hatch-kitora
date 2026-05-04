import { OrgRole, type Prisma } from '@prisma/client';

import { recordAudit } from '@/services/audit';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { provisionSsoUser } from '@/services/sso/jit';
import { authenticateScim, scimError, scimJson } from '@/services/sso/scim-auth';
import {
  parseFilterField,
  parseUserNameEqFilter,
  roleFromGroupId,
  toScimUser,
} from '@/services/sso/scim-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-4 — SCIM 用户集合。
 *
 *   GET  /api/scim/v2/Users[?filter=userName eq "x"&startIndex=1&count=20]
 *   POST /api/scim/v2/Users  — 在 SCIM 组织中创建用户 + 成员资格
 *
 * IdP 端连接器首先调用 GET 来发现现有用户，然后
 * POST 来配置它已分配的用户。我们的 `id` 是成员资格行 id
 * （根据 RFC 0004 §4.3），所以稍后 SCIM DELETE 干净地删除该租户的绑定，
 * 而不会扰乱用户行。
 */

export async function GET(request: Request) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return scimError(auth.status, auth.reason);

  const url = new URL(request.url);
  const filter = url.searchParams.get('filter');
  const startIndex = clampInt(url.searchParams.get('startIndex'), 1, 1, 10_000);
  const count = clampInt(url.searchParams.get('count'), 50, 0, 200);

  // 构建 where 子句。默认 → 租户中的所有（未删除）成员资格。
  // 使用 `eq` 过滤器，我们缩小范围 — `userName` 是用户的电子邮件；
  // `externalId` 映射到 `providerSubject`。
  const baseWhere: Prisma.MembershipWhereInput = {
    orgId: auth.orgId,
    deletedAt: null,
  };
  let where: Prisma.MembershipWhereInput = baseWhere;

  if (filter) {
    const field = parseFilterField(filter);
    const value = parseUserNameEqFilter(filter);
    if (!field || !value) {
      return scimError(400, `unsupported-filter: ${filter}`, { scimType: 'invalidFilter' });
    }
    where =
      field === 'userName'
        ? { ...baseWhere, user: { email: value.toLowerCase() } }
        : { ...baseWhere, providerSubject: value };
  }

  const [rows, totalResults] = await Promise.all([
    prisma.membership.findMany({
      where,
      skip: count === 0 ? 0 : Math.max(0, startIndex - 1),
      take: count === 0 ? 0 : count,
      orderBy: { joinedAt: 'asc' },
      select: {
        id: true,
        role: true,
        deletedAt: true,
        providerSubject: true,
        user: { select: { id: true, email: true, name: true } },
      },
    }),
    prisma.membership.count({ where }),
  ]);

  return scimJson(200, {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults,
    startIndex,
    itemsPerPage: rows.length,
    Resources: rows.map((r) =>
      toScimUser(
        {
          id: r.user.id,
          email: r.user.email,
          name: r.user.name,
          membershipId: r.id,
          role: r.role,
          deletedAt: r.deletedAt,
          providerSubject: r.providerSubject,
        },
        auth.orgSlug,
      ),
    ),
  });
}

interface CreateBody {
  schemas?: unknown;
  userName?: unknown;
  externalId?: unknown;
  name?: { givenName?: unknown; familyName?: unknown };
  active?: unknown;
  emails?: { value?: unknown; primary?: unknown }[];
  groups?: { value?: unknown }[];
}

export async function POST(request: Request) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return scimError(auth.status, auth.reason);

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return scimError(400, 'invalid-json');
  }

  const userName = stringField(body.userName);
  if (!userName) {
    return scimError(400, 'userName is required', { scimType: 'invalidValue' });
  }
  const email = userName.toLowerCase();

  const externalId = stringField(body.externalId);
  const givenName = stringField(body.name?.givenName);
  const familyName = stringField(body.name?.familyName);
  const composedName =
    [givenName, familyName]
      .filter((s): s is string => !!s)
      .join(' ')
      .trim() || null;

  // 组 → 角色。默认成员。我们根据 RFC 0004 §4.4 拒绝所有者：
  // 该晋升必须在 Kitora 内进行。
  let role: OrgRole = OrgRole.MEMBER;
  if (Array.isArray(body.groups) && body.groups.length > 0) {
    for (const g of body.groups) {
      const v = stringField(g.value);
      if (!v) continue;
      const r = roleFromGroupId(v);
      if (r === null) continue;
      if (r === OrgRole.OWNER) {
        return scimError(400, 'OWNER cannot be assigned via SCIM', { scimType: 'noTarget' });
      }
      role = r;
    }
  }

  // 幂等性：如果租户中已存在带有此 externalId 或电子邮件的成员资格，
  // 根据 SCIM 约定返回 409。
  const existing = await prisma.membership.findFirst({
    where: {
      orgId: auth.orgId,
      OR: [
        ...(externalId ? [{ providerSubject: externalId, providerId: auth.idpId }] : []),
        { user: { email } },
      ],
    },
    select: { id: true },
  });
  if (existing) {
    return scimError(409, 'user already exists', { scimType: 'uniqueness' });
  }

  // 重用 JIT 管道，以便审计 +（现有用户通过电子邮件）处理
  // 与 SAML/OIDC 登录配置保持一致。
  let jit;
  try {
    jit = await provisionSsoUser({
      providerId: auth.idpId,
      providerSubject: externalId ?? `scim:${userName}`,
      email,
      name: composedName,
      orgId: auth.orgId,
      defaultRole: role,
    });
  } catch (err) {
    logger.error({ err, userName }, 'scim-user-create-failed');
    return scimError(500, 'provision-failed');
  }

  const membership = await prisma.membership.findFirstOrThrow({
    where: { userId: jit.userId, orgId: auth.orgId },
    select: {
      id: true,
      role: true,
      deletedAt: true,
      providerSubject: true,
      user: { select: { id: true, email: true, name: true } },
    },
  });

  // SCIM 在创建时默认 `active = true`。如果调用者传递了 `active: false`，
  // 我们通过 deletedAt 来遵守它。
  if (body.active === false) {
    await prisma.membership.update({
      where: { id: membership.id },
      data: { deletedAt: new Date() },
    });
    membership.deletedAt = new Date();
  }

  // 如果创建有效载荷要求，晋升为 ADMIN。（我们在上面预先验证了 OWNER，
  // 所以这只能落在 MEMBER 或 ADMIN 上。）
  if (role !== OrgRole.MEMBER && membership.role !== role) {
    await prisma.membership.update({ where: { id: membership.id }, data: { role } });
    membership.role = role;
  }

  await recordAudit({
    actorId: null,
    orgId: auth.orgId,
    action: 'scim.user_provisioned',
    target: membership.id,
    metadata: { email, externalId, role },
  });

  return scimJson(
    201,
    toScimUser(
      {
        id: membership.user.id,
        email: membership.user.email,
        name: membership.user.name,
        membershipId: membership.id,
        role: membership.role,
        deletedAt: membership.deletedAt,
        providerSubject: membership.providerSubject,
      },
      auth.orgSlug,
    ),
  );
}

// ─── 助手函数 ────────────────────────────────────────────────────────────────

function stringField(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
