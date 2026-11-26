require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
(async () => {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  const c = new Client({ connectionString: url, ssl: /supabase|pooler|neon|amazonaws/.test(url) ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  const ex = await c.query("select to_regclass('public.class_notes') as t");
  if (ex.rows[0].t) { console.log('class_notes already exists - nothing to do'); await c.end(); return; }
  const parts = fs.readFileSync('drizzle/0015_class_notes.sql', 'utf8').split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);
  try {
    await c.query('BEGIN');
    for (const p of parts) await c.query(p);
    await c.query('COMMIT');
    console.log('class_notes created (' + parts.length + ' statements)');
  } catch (e) { await c.query('ROLLBACK'); console.error('FAILED, rolled back:', e.message); process.exitCode = 1; }
  await c.end();
})();
