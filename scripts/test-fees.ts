import { pool } from "../src/db";
import { publishStructure } from "../src/modules/feeCollection/feeCollection.service";

const CLASS_ID = 5;        // Class V
const TENANT_ID = 17n;     // your school
const AMOUNT = Number(process.argv[2] ?? 20000);

async function main() {
  // 1) a fee structure for Class V (reuse it if it already exists)
  let s = await pool.query("select id from fee_structures where tenant_id = $1 and class_id = $2 limit 1", [TENANT_ID.toString(), CLASS_ID]);
  if (!s.rows[0]) {
    s = await pool.query(
      `insert into fee_structures (tenant_id, academic_year_id, class_id, name, code, frequency, status)
       values ($1, 1, $2, 'Class V Annual Fees', 'CLS5', 'annual', 'active') returning id`,
      [TENANT_ID.toString(), CLASS_ID]
    );
    console.log("created structure", s.rows[0].id);
  }
  const structureId = BigInt(s.rows[0].id);

  // 2) one Tuition item (fee type 1), amount from the command line
  const it = await pool.query("select id from fee_structure_items where fee_structure_id = $1", [structureId.toString()]);
  if (!it.rows[0]) {
    await pool.query(
      `insert into fee_structure_items (tenant_id, fee_structure_id, fee_type_id, amount, is_optional, due_on)
       values ($1, $2, 1, $3, false, '2026-12-31')`,
      [TENANT_ID.toString(), structureId.toString(), AMOUNT]
    );
    console.log("added Tuition item", AMOUNT);
  }

  // 3) publish = the "Update" button
  const tenant: any = { id: TENANT_ID, slug: "", name: "", roles: [], permissions: new Set(["*"]) };
  console.log("PUBLISH RESULT:", await publishStructure(tenant, structureId));

  // 4) what the students now owe
  const inv = await pool.query(
    `select i.number, i.student_id, i.status, i.due_on::text as due_on,
            coalesce(sum(l.line_total),0) as total
       from invoices i left join invoice_lines l on l.invoice_id = i.id
      where i.number like $1 group by i.id order by i.id`,
    [`FS${structureId}-S%`]
  );
  console.table(inv.rows);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); });