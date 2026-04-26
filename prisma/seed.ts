import { PrismaClient, Region, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@kitora.dev';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345';
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  // RFC 0005 — seeds always target the GLOBAL region. The CN / EU stacks
  // have their own seed runs (parametrise via `SEED_REGION` if you ever
  // need to seed a non-default region locally).
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
