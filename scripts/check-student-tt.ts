import { pool } from "../src/db";

async function main() {
  // login value (the username, e.g. a mobile number) - all args joined
  const who = process.argv.slice(2).join(" ").trim();
  if (!who) throw new Error('usage: npx tsx scripts\\check-student-tt.ts "<username / email>"');

  const u = await pool.query(
    "select id, email, username from users where username = $1 or email = $1",
    [who]
  );
  console.log("USER:", u.rows);
  if (!u.rows[0]) {
    console.log("No user with that username/email.");
    return;
  }

  const s = await pool.query("select * from students where user_id = $1", [u.rows[0].id]);
  console.log("STUDENT ids linked to this login:", s.rows.map((r) => r.id));
  if (!s.rows[0]) {
    console.log("This login is NOT linked to a student (students.user_id is empty for it).");
    return;
  }

  const a = await pool.query(
    "select id, student_id, class_id, status from admissions where student_id = $1",
    [s.rows[0].id]
  );
  console.log("ADMISSIONS (short):", a.rows);

  const classIds = a.rows.map((r) => r.class_id);
  const sec = await pool.query("select * from sections where class_id = any($1::bigint[])", [classIds]);
  console.log("SECTIONS OF THE STUDENT'S CLASS:");
  console.table(sec.rows.map((r) => ({ id: r.id, class_id: r.class_id, name: r.name })));

  // select * so we do not depend on exact column names
  const t = await pool.query("select * from timetable_entries order by id desc limit 10");
  console.log("LATEST TIMETABLE ENTRIES (all columns):");
  console.log(
    JSON.stringify(
      t.rows.map((r) => {
        const o: Record<string, unknown> = {};
        for (const k of Object.keys(r)) {
          if (["created_at", "updated_at", "tenant_id", "deleted_at"].includes(k)) continue;
          o[k] = r[k] instanceof Date ? r[k].toISOString() : r[k];
        }
        return o;
      }),
      null,
      1
    )
  );
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error(e);
    pool.end();
  });