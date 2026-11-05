import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { PERMISSIONS, DEFAULT_ROLES } from './permissions';

const prisma = new PrismaClient();

// A fallback login for demos: always works even if live sign-up has a glitch on stage.
const DEMO_EMAIL = 'admin@karkaii.demo';
const DEMO_PASSWORD = 'Demo12345!';
const DEMO_SCHOOL_SLUG = 'karkaii-demo';
const DEMO_SCHOOL_NAME = 'Karkaii Demo School';

// Loads the permission catalogue into the database. Safe to run many times (upsert), and you re-run it
// whenever you add a permission to src/permissions.ts.
//   Development:  npx prisma db seed      Production (compiled):  node dist/seed.js
async function main() {
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      update: { module: p.module, action: p.action, description: p.description },
      create: { code: p.code, module: p.module, action: p.action, description: p.description },
    });
  }
  console.log(`Seeded ${PERMISSIONS.length} permissions.`);

  await seedDemoAccount();
}

// Idempotent: does nothing if the demo user already exists. Mirrors modules/organizations/organizations.service.ts
// (createOrganization) so the demo account is a real owner, not a database shortcut.
async function seedDemoAccount() {
  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) {
    console.log(`Demo account already exists: ${DEMO_EMAIL}`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: DEMO_EMAIL,
        fullName: 'Demo Admin',
        passwordHash: await argon2.hash(DEMO_PASSWORD),
        passwordChangedAt: new Date(),
        emailVerifiedAt: new Date(),
      },
    });

    const org = await tx.organization.create({
      data: { slug: DEMO_SCHOOL_SLUG, name: DEMO_SCHOOL_NAME, timezone: 'UTC' },
    });

    const permissions = await tx.permission.findMany({ select: { id: true, code: true } });
    const permissionId = new Map(permissions.map((p) => [p.code, p.id]));
    let ownerRoleId: bigint | undefined;

    for (const def of DEFAULT_ROLES) {
      const role = await tx.role.create({
        data: { tenantId: org.id, code: def.code, name: def.name, description: def.description, isSystem: true },
      });
      if (def.code === 'owner') ownerRoleId = role.id;
      if (def.permissions.length > 0) {
        await tx.rolePermission.createMany({
          data: def.permissions.map((code) => ({
            roleId: role.id,
            permissionId: permissionId.get(code)!,
            tenantId: org.id,
          })),
        });
      }
    }
    if (!ownerRoleId) throw new Error('DEFAULT_ROLES must contain an "owner" role');

    await tx.membership.create({
      data: {
        tenantId: org.id,
        userId: user.id,
        roles: { create: [{ roleId: ownerRoleId, tenantId: org.id }] },
      },
    });
  });

  console.log(`Seeded demo account: ${DEMO_EMAIL} / ${DEMO_PASSWORD} (school: ${DEMO_SCHOOL_SLUG})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
