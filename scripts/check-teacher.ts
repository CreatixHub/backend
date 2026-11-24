// Shows what the teacher dashboard will find for one teacher, and why something may be missing.
//
// Usage:  npx tsx scripts/check-teacher.ts "<name, mobile, username or email>"
//   e.g.  npx tsx scripts/check-teacher.ts 9876543210
//         npx tsx scripts/check-teacher.ts Priya
import { Client } from 'pg';
import { config } from '../src/config';

async function main() {
  const term = (process.argv[2] ?? '').trim();
  if (!term) {
    console.log('Give a name, mobile number, username or email.');
    process.exit(1);
  }
  const url = config.DIRECT_URL ?? config.DATABASE_URL;
  const c = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  await c.connect();
  try {
    const digits = term.replace(/\D/g, '').slice(-10);
    const users = await c.query(
      `SELECT id, full_name, username, email, phone, user_type, status FROM users
       WHERE deleted_at IS NULL AND (
         full_name ILIKE $1 OR lower(username) = lower($2) OR lower(email) = lower($2)
         OR ($3 <> '' AND right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10) = $3)
         OR ($3 <> '' AND right(regexp_replace(coalesce(username,''), '[^0-9]', '', 'g'), 10) = $3))
       ORDER BY id LIMIT 10`,
      [`%${term}%`, term, digits.length === 10 ? digits : ''],
    );
    if (users.rows.length === 0) console.log('\nNo login (user) found for "' + term + '".');

    for (const u of users.rows) {
      console.log(`\n=== LOGIN #${u.id}: ${u.full_name} | username ${u.username} | type ${u.user_type} | ${u.status}`);
      const st = await c.query(
        `SELECT id, employee_no, staff_type, status FROM staff WHERE user_id = $1 AND deleted_at IS NULL`, [u.id]);
      if (st.rows.length === 0) {
        console.log('  !! NO staff record is linked to this login.');
        console.log('     The teacher dashboard (My Timetable / Sections / Assignments) needs one.');
        continue;
      }
      for (const s of st.rows) {
        console.log(`  staff #${s.id} | employee ${s.employee_no} | ${s.staff_type} | ${s.status}`);

        const a = await c.query(
          `SELECT st2.id, cl.name AS class_name, se.name AS section_name, su.name AS subject_name
           FROM section_teachers st2
           JOIN sections se ON se.id = st2.section_id
           JOIN classes cl ON cl.id = se.class_id
           JOIN subjects su ON su.id = st2.subject_id
           WHERE st2.teacher_id = $1 ORDER BY cl.name, se.name, su.name`, [s.id]);
        console.log(`  Section-teacher assignments (shows in "My Assignments"): ${a.rows.length}`);
        for (const r of a.rows) console.log(`    - ${r.class_name} ${r.section_name} : ${r.subject_name}`);

        const t = await c.query(
          `SELECT te.id, te.day_of_week, te.status, te.effective_from, te.effective_to,
                  cl.name AS class_name, se.name AS section_name, su.name AS subject_name, ts.name AS slot_name
           FROM timetable_entries te
           JOIN sections se ON se.id = te.section_id
           JOIN classes cl ON cl.id = se.class_id
           JOIN subjects su ON su.id = te.subject_id
           JOIN time_slots ts ON ts.id = te.time_slot_id
           WHERE te.teacher_id = $1 ORDER BY te.day_of_week, te.time_slot_id`, [s.id]);
        console.log(`  Timetable entries (feed "My Timetable" and "My Sections"): ${t.rows.length}`);
        const today = new Date().toISOString().slice(0, 10);
        for (const r of t.rows) {
          const from = String(r.effective_from).slice(0, 10);
          const to = r.effective_to ? String(r.effective_to).slice(0, 10) : null;
          const why =
            r.status !== 'active' ? '  <-- NOT SHOWN: status is ' + r.status
            : from > today ? '  <-- NOT SHOWN YET: starts ' + from
            : to && to < today ? '  <-- NOT SHOWN: ended ' + to
            : '';
          console.log(`    - day ${r.day_of_week} | ${r.slot_name} | ${r.class_name} ${r.section_name} | ${r.subject_name} | from ${from}${why}`);
        }
        if (a.rows.length > 0 && t.rows.length === 0) {
          console.log('  !! Assigned to sections but NO timetable entry exists.');
          console.log('     "My Timetable" and "My Sections" stay empty until you add Timetable entries for this teacher.');
        }
      }
    }

    const loose = await c.query(
      `SELECT s.id, s.employee_no FROM staff s WHERE s.user_id IS NULL AND s.deleted_at IS NULL ORDER BY s.id`);
    if (loose.rows.length > 0) {
      console.log(`\nStaff records with NO login linked (${loose.rows.length}): ` +
        loose.rows.map((r) => `#${r.id} (${r.employee_no})`).join(', '));
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
