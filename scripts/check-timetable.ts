import "dotenv/config";
import pg from "pg";

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const days = await c.query(
      `select te.day_of_week as day, te.status, count(*)::int as entries
         from timetable_entries te
        group by te.day_of_week, te.status
        order by te.day_of_week, te.status`,
    );
    console.log("1) Timetable entries per weekday (1 = Monday ... 7 = Sunday):");
    console.table(days.rows);

    const t = await c.query(
      `select s.id as staff_id, s.employee_no, s.full_name, s.user_id as linked_user_id,
              u.username as login_username, u.email as login_email,
              array_agg(distinct te.day_of_week order by te.day_of_week) as days,
              count(*)::int as periods
         from timetable_entries te
         join staff s on s.id = te.teacher_id
         left join users u on u.id = s.user_id
        where te.status = 'active'
        group by s.id, s.employee_no, s.full_name, s.user_id, u.username, u.email
        order by s.full_name`,
    );
    console.log("\n2) Teachers who have timetable periods, their linked login, and their weekdays:");
    console.table(t.rows);

    const e = await c.query(
      `select min(te.effective_from) as earliest_from, max(te.effective_to) as latest_to from timetable_entries te`,
    );
    console.log("\n3) Date range covered by the timetable:");
    console.table(e.rows);
  } catch (err) {
    console.log("FAILED:", (err as Error).message);
  } finally {
    await c.end().catch(() => {});
  }
}

main();