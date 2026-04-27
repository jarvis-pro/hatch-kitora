import { PrismaClient, Region, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@kitora.dev';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345';
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  // RFC 0005 — seed 始终针对 GLOBAL region。CN / EU 栈有各自的 seed 运行
  // （如需在非默认 region 本地 seed，通过 `SEED_REGION` 参数化即可）。
  const seedRegion = (process.env.SEED_REGION as Region | undefined) ?? Region.GLOBAL;

  const admin = await prisma.user.upsert({
    where: { email_region: { email: adminEmail, region: seedRegion } },
    update: {},
    create: {
      email: adminEmail,
      name: 'Admin',
      role: UserRole.ADMIN,
      passwordHash,
      emailVerified: new Date(),
      region: seedRegion,
    },
  });

  console.log(`✅ Seeded admin user: ${admin.email} (${seedRegion})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
