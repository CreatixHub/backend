// What does "My Class" return for a teacher login?
// Usage:  npx tsx scripts/check-my-class.ts ME-102
import { Client } from 'pg';
import { config } from '../src/config';
import { getMyClass } from '../src/modules/staff/staff.myClass';

async function main() {
  const username = (process.argv[2] ?? '').trim();
  const url = config.DIRECT_URL ?? config.DATABASE_URL;
  const c = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  await c.connect();
  const r = await c.query(
    `SELECT u.id AS user_id, s.id AS staff_id, s.tenant_id FROM users u JOIN staff s ON s.user_id = u.id
     WHERE lower(u.username) = lower($1) AND s.deleted_at IS NULL LIMIT 1`, [username]);
  if (r.rows.length === 0) { console.log('No staff login ' + username); await c.end(); return; }
  const ct = await c.query(
    `SELECT cl.name AS class_name FROM class_teachers ct JOIN classes cl ON cl.id = ct.class_id
     WHERE ct.teacher_id = $1`, [r.rows[0].staff_id]);
  console.log('Class teacher records for staff #' + r.rows[0].staff_id + ': ' +
    (ct.rows.map((x) => x.class_name).join(', ') || 'NONE'));
  await c.end();

  const tenant = { id: BigInt(r.rows[0].tenant_id), slug: '', name: '', roles: [], permissions: new Set<string>() } as any;
  const v: any = await getMyClass(tenant, { id: BigInt(r.rows[0].user_id) } as any);
  console.log(v.message || 'OK');
  for (const k of v.classes) console.log(`  ${k.name}: ${k.studentCount} student(s)` + (k.students.length ? ' - ' + k.students.map((s: any) => s.fullName ?? s.firstName).join(', ') : ''));
  process.exit(0);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
