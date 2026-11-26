import "dotenv/config";
import pg from "pg";

async function main() {
  const fix = process.argv.includes("--fix");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const r = await c.query(
      `select te.id, s.employee_no, s.full_name, te.day_of_week as day,
              te.effective_from::text as effective_from, te.effective_to::text as effective_to, te.status
         from timetable_entries te
         join staff s on s.id = te.teacher_id
        order by s.full_name, te.day_of_week, te.id`,
    );
    console.log("Timetable entries (dates shown as plain text, no timezone shift):");
    console.table(r.rows);

    if (fix) {
      const u = await c.query(
        `update timetable_entries set effective_from = '2026-11-01'
          where effective_from > '2026-11-01'`,
      );
      console.log("Updated rows:", u.rowCount, "-> effective_from is now 2026-11-01");
    } else {
      console.log("\nNothing changed. To move every start date back to 2026-11-01 run with --fix");
    }
  } catch (e) {
    console.log("FAILED:", (e as Error).message);
  } finally {
    await c.end().catch(() => {});
  }
}

main();