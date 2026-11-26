// Seeds a demo school for the timetable planner and prints the demo owner's login at the end.
// NOT idempotent: every run creates a new random demo school and a new owner login.
// Only writes to a local database. Any other host needs PLANNER_SEED_ALLOW_HOST=<that exact host>,
// and NODE_ENV=production is always refused. See scripts/seedGuard.ts.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { assertSeedTarget } from './seedGuard';

async function main() {
  // Check where DATABASE_URL points before loading anything that opens a database connection
  // (the db module connects as soon as it is imported, so it is imported dynamically below).
  const target = assertSeedTarget(process.env.DATABASE_URL, process.env);
  console.log(`Seeding the planner demo into database "${target.database}" on ${target.host}:${target.port}.`);

  const { pool } = await import('../src/db');
  try {
    const { signup, switchOrganization, logout } = await import('../src/modules/auth/auth.service');
    const { createOrganization } = await import('../src/modules/organizations/organizations.service');
    const { resolveAcademicYearId } = await import('../src/modules/academic-years/academicYears.service');
    const { seedPlannerCurriculum } = await import('../tests/helpers/plannerSchool');

    const slug = `planner-demo-${randomBytes(6).toString('hex')}`;
    const email = `admin@${slug}.example.test`;
    const password = randomBytes(24).toString('base64url');
    const { user, session } = await signup({ fullName: 'Planner Demo Admin', email, password }, {});
    try {
      await createOrganization({ name: 'Planner Demo School', slug, timezone: 'Asia/Kolkata' }, user);
      const { tenant } = await switchOrganization(user.id, slug, session.refreshToken, {});
      if (!tenant) throw new Error(`The demo owner could not access the new school ${slug}.`);
      const yearId = await resolveAcademicYearId(tenant);
      await seedPlannerCurriculum(tenant, yearId);
    } finally {
      await logout(session.refreshToken);
    }

    console.log(`Seeded ${slug}. Sign in as ${email} with password ${password}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'The planner demo seed failed.');
  process.exitCode = 1;
});
