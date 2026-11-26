import { pool } from "../src/db";

async function main() {
  const sec = await pool.query("select id, class_id, name, status, deleted_at from sections where id = 3");
  console.log("SECTION 3:", sec.rows);

  const slots = await pool.query("select id, name, sequence, is_active from time_slots order by sequence");
  console.table(slots.rows);

  const e = await pool.query(`
    select te.id, te.day_of_week, te.status,
           s.name  as subject,
           st.full_name as teacher,
           ts.name as slot, ts.is_active as slot_active
    from timetable_entries te
    left join subjects s   on s.id  = te.subject_id
    left join staff st     on st.id = te.teacher_id
    left join time_slots ts on ts.id = te.time_slot_id
    where te.section_id = 3
    order by te.day_of_week`);
  console.log("ENTRIES FOR SECTION 3 (with joins):");
  console.table(e.rows);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
  });