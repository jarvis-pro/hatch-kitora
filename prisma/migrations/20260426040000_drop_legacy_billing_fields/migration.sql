-- PR-4 收尾迁移（RFC-0001）
--   1. 把 Subscription.orgId / ApiToken.orgId 改成 NOT NULL
--   2. 删除 User.stripeCustomerId（已迁到 Organization）
--   3. 删除 Subscription.userId（org-scoped 后不再需要）
--
-- 前置：必须先跑 `pnpm db:backfill-orgs` 让所有 Subscription / ApiToken 拿到 orgId。
-- 下面的 DO 块在还有 NULL 时直接 RAISE，迁移会原子回滚，不会留半截 schema。

-- Sanity guard
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Subscription" WHERE "orgId" IS NULL) THEN
    RAISE EXCEPTION 'Subscription has rows with NULL orgId — run pnpm db:backfill-orgs first';
  END IF;
  IF EXISTS (SELECT 1 FROM "ApiToken" WHERE "orgId" IS NULL) THEN
    RAISE EXCEPTION 'ApiToken has rows with NULL orgId — run pnpm db:backfill-orgs first';
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_userId_fkey";

-- DropIndex
DROP INDEX "User_stripeCustomerId_key";

-- DropIndex
DROP INDEX "Subscription_userId_idx";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "stripeCustomerId";

-- AlterTable
ALTER TABLE "Subscription" DROP COLUMN "userId",
ALTER COLUMN "orgId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ApiToken" ALTER COLUMN "orgId" SET NOT NULL;
