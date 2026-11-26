// Shows, for every fee structure, how many students are in the class and how many have a bill.
// Optional: pass a student's mobile number to see exactly what that student has.
//
// Usage:  npx tsx scripts/check-class-fees.ts
//         npx tsx scripts/check-class-fees.ts 9876543210
import { Client } from 'pg';
import { config } from '../src/config';

async function main() {
  const mobile = (process.argv[2] ?? '').replace(/\D/g, '').slice(-10);
  const url = config.DIRECT_URL ?? config.DATABASE_URL;
  const c = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  await c.connect();
  try {
    console.log('\n=== FEE STRUCTURES ===');
    const s = await c.query(`
      SELECT fs.id, fs.name, fs.status, fs.class_id, cl.name AS class_name,
        (SELECT count(*)::int FROM fee_structure_items i WHERE i.fee_structure_id = fs.id) AS items,
        (SELECT coalesce(sum(i.amount),0) FROM fee_structure_items i WHERE i.fee_structure_id = fs.id) AS total,
        (SELECT count(*)::int FROM students st JOIN admissions a ON a.id = st.admission_id
           WHERE a.class_id = fs.class_id AND st.status = 'active') AS active_students,
        (SELECT count(*)::int FROM invoices v WHERE v.number LIKE 'FS' || fs.id || '-S%') AS bills
      FROM fee_structures fs LEFT JOIN classes cl ON cl.id = fs.class_id
      ORDER BY fs.id`);
    for (const r of s.rows) {
      const hint =
        r.status !== 'active' ? '  <-- structure is not active'
        : r.items === 0 ? '  <-- NO FEE AMOUNT added'
        : r.active_students === 0 ? '  <-- NO active students admitted to this class'
        : r.bills === 0 ? '  <-- amounts added but "Update - bill all students" NOT pressed'
        : r.bills < r.active_students ? '  <-- some students not billed: press Update again'
        : '  OK';
      console.log(`#${r.id} ${r.name ?? '(no name)'} | class ${r.class_name} | status ${r.status} | items ${r.items} | total ${r.total} | students ${r.active_students} | bills ${r.bills}${hint}`);
    }

    if (mobile.length === 10) {
      console.log(`\n=== STUDENT ${mobile} ===`);
      const st = await c.query(
        `SELECT st.id, st.admission_no, st.full_name, st.status, st.user_id, st.admission_id,
                a.class_id, cl.name AS class_name, u.username
         FROM students st
         LEFT JOIN users u ON u.id = st.user_id
         LEFT JOIN admissions a ON a.id = st.admission_id
         LEFT JOIN classes cl ON cl.id = a.class_id
         WHERE right(regexp_replace(coalesce(u.username,''), '[^0-9]', '', 'g'), 10) = $1
            OR right(regexp_replace(coalesce(u.phone,''), '[^0-9]', '', 'g'), 10) = $1`,
        [mobile],
      );
      if (st.rows.length === 0) console.log('No student account found for this mobile number.');
      for (const r of st.rows) {
        console.log(`student #${r.id} ${r.full_name} | adm ${r.admission_no} | status ${r.status} | class ${r.class_name ?? 'NONE (admission has no class)'}`);
        const inv = await c.query(
          `SELECT number, status, due_on FROM invoices WHERE student_id = $1 ORDER BY id`, [r.id]);
        if (inv.rows.length === 0) console.log('  no bills for this student');
        for (const v of inv.rows) console.log(`  bill ${v.number} | ${v.status} | due ${v.due_on}`);
      }
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
