import "dotenv/config";
import pg from "pg";

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const js = new Date().getDay();
    const today = js === 0 ? 7 : js;

    const r = await c.query(
      `select distinct s.id as staff_id, s.employee_no, s.full_name,
              s.user_id as linked_user_id, u.email as login_email, u.username as login_username, u.status as login_status
         from timetable_entries te
         join staff s on s.id = te.teacher_id
         left join users u on u.id = s.user_id
        where te.status = 'active' and te.day_of_week = $1
        order by s.full_name`,
      [today],
    );
    console.log("Teachers with a period on weekday", today, ":");
    console.table(r.rows);

    const un = r.rows.filter((x) => !x.linked_user_id);
    if (un.length) console.log("PROBLEM: these teachers have NO login linked:", un.map((x) => x.full_name).join(", "));

    const users = await c.query(
      `select u.id as user_id, u.email, u.username, u.full_name, u.user_type
         from users u
        where u.user_type in ('staff','teacher') and u.deleted_at is null
        order by u.full_name limit 40`,
    );
    console.log("\nStaff logins (to find the right one to link):");
    console.table(users.rows);
  } catch (e) {
    console.log("FAILED:", (e as Error).message);
  } finally {
    await c.end().catch(() => {});
  }
}

main();