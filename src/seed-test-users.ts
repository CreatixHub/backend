/* eslint-disable no-console */
/**
 * Creates one test login per role in an EXISTING school (the one owned by the email you pass).
 *
 *   npx tsx src/seed-test-users.ts owner@example.com
 *
 * Safe to run again: accounts that already exist are skipped, missing role links are added.
 * Every account gets the same password (below). Test data only - delete these users before production.
 */
import * as argon2 from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { membershipRoles, memberships, roles, users } from './db/schema';

const PASSWORD = 'Karkaii@12345';

const ROLE_CODES = [
  'admin', 'teacher', 'student', 'parent', 'accountant', 'receptionist',
  'librarian', 'warden', 'transport_manager', 'nurse', 'security',
];

const label = (code: string) =>
  code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');

async function main() {
  const ownerEmail = process.argv[2]?.trim().toLowerCase();
  if (!ownerEmail) {
    console.error('Usage: npx tsx src/seed-test-users.ts <email of the school owner>');
    process.exit(1);
  }

  // 1. the school: the one the owner belongs to
  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, ownerEmail)).limit(1);
  if (!owner) {
    console.error(`No user with email ${ownerEmail}`);
    process.exit(1);
  }
  const [ownerMembership] = await db
    .select({ tenantId: memberships.tenantId })
    .from(memberships)
    .where(eq(memberships.userId, owner.id))
    .limit(1);
  if (!ownerMembership) {
    console.error(`${ownerEmail} has no school yet. Register a school with this email first.`);
    process.exit(1);
  }
  const tenantId = ownerMembership.tenantId;

  const passwordHash = await argon2.hash(PASSWORD);
  const created: string[] = [];
  const existing: string[] = [];

  for (const code of ROLE_CODES) {
    // 2. this school's copy of the role
    const [role] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.code, code)))
      .limit(1);
    if (!role) {
      console.warn(`Skipped "${code}": this school has no such role.`);
      continue;
    }

    // 3. the person
    const email = `${code.replace(/_/g, '')}@school.test`;
    let [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (user) {
      existing.push(email);
    } else {
      [user] = await db
        .insert(users)
        .values({ email, fullName: `Demo ${label(code)}`, passwordHash, passwordChangedAt: new Date() })
        .returning({ id: users.id });
      created.push(email);
    }

    // 4. member of the school
    let [membership] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, user.id)))
      .limit(1);
    if (!membership) {
      [membership] = await db
        .insert(memberships)
        .values({ tenantId, userId: user.id })
        .returning({ id: memberships.id });
    }

    // 5. holding the role
    const [link] = await db
      .select({ id: membershipRoles.membershipId })
      .from(membershipRoles)
      .where(and(eq(membershipRoles.membershipId, membership.id), eq(membershipRoles.roleId, role.id)))
      .limit(1);
    if (!link) {
      await db.insert(membershipRoles).values({ membershipId: membership.id, roleId: role.id, tenantId });
    }
  }

  console.log(`\nCreated ${created.length} account(s), ${existing.length} already existed.`);
  console.log(`Password for all of them: ${PASSWORD}\n`);
  for (const code of ROLE_CODES) console.log(`  ${code.padEnd(18)} ${code.replace(/_/g, '')}@school.test`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});