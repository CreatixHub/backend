import "dotenv/config";
import pg from "pg";

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const r = await c.query(
      `select te.id, s.employee_no as teacher, c.name as class, sec.name as section, sub.name as subject,
              ts.name as slot, ts.is_break as brk, te.day_of_week as day,
              te.effective_from::text as from_date, te.effective_to::text as to_date, te.status,
              te.created_at at time zone 'Asia/Kolkata' as created_ist
         from timetable_entries te
         join staff s on s.id = te.teacher_id
         join sections sec on sec.id = te.section_id
         join classes c on c.id = sec.class_id
         join subjects sub on sub.id = te.subject_id
         join time_slots ts on ts.id = te.time_slot_id
        order by te.id desc limit 12`,
    );
    console.log("Latest timetable entries in the database this backend uses:");
    console.table(r.rows);
  } catch (e) {
    console.log("FAILED:", (e as Error).message);
  } finally {
    await c.end().catch(() => {});
  }
}

main();