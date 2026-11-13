import * as argon2 from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from './config';
import * as schema from './db/schema';
import { PERMISSIONS, DEFAULT_ROLES } from './permissions';

const pool = new Pool({ connectionString: config.DATABASE_URL });
const db = drizzle(pool, { schema });

// A fallback login for demos: always works even if live sign-up has a glitch on stage.
const DEMO_EMAIL = 'admin@karkaii.demo';
const DEMO_PASSWORD = 'Demo12345!';
const DEMO_SCHOOL_SLUG = 'karkaii-demo';
const DEMO_SCHOOL_NAME = 'Karkaii Demo School';

// Loads the permission catalogue into the database. Safe to run many times (upsert), and you re-run it
// whenever you add a permission to src/permissions.ts.
//   Development:  npx tsx src/seed.ts      Production (compiled):  node dist/seed.js
async function main() {
  for (const p of PERMISSIONS) {
    await db
      .insert(schema.permissions)
      .values({ code: p.code, module: p.module, action: p.action, description: p.description })
      .onConflictDoUpdate({
        target: schema.permissions.code,
        set: { module: p.module, action: p.action, description: p.description },
      });
  }
  console.log(`Seeded ${PERMISSIONS.length} permissions.`);

  await seedDemoAccount();
}

// Idempotent: does nothing if the demo user already exists. Mirrors modules/organizations/organizations.service.ts
// (createOrganization) so the demo account is a real owner, not a database shortcut.
async function seedDemoAccount() {
  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, DEMO_EMAIL)).limit(1);
  if (existing) {
    console.log(`Demo account already exists: ${DEMO_EMAIL}`);
    return;
  }

  await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(schema.users)
      .values({
        email: DEMO_EMAIL,
        fullName: 'Demo Admin',
        passwordHash: await argon2.hash(DEMO_PASSWORD),
        passwordChangedAt: new Date(),
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });

    const [org] = await tx
      .insert(schema.organizations)
      .values({ slug: DEMO_SCHOOL_SLUG, name: DEMO_SCHOOL_NAME, timezone: 'UTC' })
      .returning({ id: schema.organizations.id });

    const permissionRows = await tx.select({ id: schema.permissions.id, code: schema.permissions.code }).from(schema.permissions);
    const permissionId = new Map(permissionRows.map((p) => [p.code, p.id]));
    let ownerRoleId: bigint | undefined;

    for (const def of DEFAULT_ROLES) {
      const [role] = await tx
        .insert(schema.roles)
        .values({ tenantId: org.id, code: def.code, name: def.name, description: def.description, isSystem: true })
        .returning({ id: schema.roles.id });
      if (def.code === 'owner') ownerRoleId = role.id;
      if (def.permissions.length > 0) {
        await tx.insert(schema.rolePermissions).values(
          def.permissions.map((code) => ({
            roleId: role.id,
            permissionId: permissionId.get(code)!,
            tenantId: org.id,
          })),
        );
      }
    }
    if (!ownerRoleId) throw new Error('DEFAULT_ROLES must contain an "owner" role');

    const [membership] = await tx
      .insert(schema.memberships)
      .values({ tenantId: org.id, userId: user.id })
      .returning({ id: schema.memberships.id });
    await tx.insert(schema.membershipRoles).values({ membershipId: membership.id, roleId: ownerRoleId, tenantId: org.id });
  });

  console.log(`Seeded demo account: ${DEMO_EMAIL} / ${DEMO_PASSWORD} (school: ${DEMO_SCHOOL_SLUG})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
