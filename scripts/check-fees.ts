import { pool } from "../src/db";

async function show(title: string, sql: string) {
  console.log(`\n== ${title}`);
  try {
    const r = await pool.query(sql);
    console.log(r.rowCount === 0 ? "(no rows)" : "");
    if (r.rowCount) console.table(r.rows);
  } catch (e) {
    console.log("ERROR:", e instanceof Error ? e.message : e);
  }
}

async function main() {
  await show("fee_types", "select id, name, code from fee_types order by id limit 20");
  await show("fee_structures", "select id, academic_year_id, class_id, name, frequency, status from fee_structures order by id limit 20");
  await show("fee_structure_items", "select id, fee_structure_id, fee_type_id, amount, due_on from fee_structure_items order by id limit 30");
  await show("invoices (count by status)", "select status, count(*)::int as n from invoices group by status");
  await show("payments (count by status)", "select status, method, count(*)::int as n from payments group by status, method");
  await show("classes", "select id, name from classes where deleted_at is null order by grade_level, name");
  await show("academic years", "select id, name, is_current from academic_years order by id desc limit 5");
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error(e);
    pool.end();
  });