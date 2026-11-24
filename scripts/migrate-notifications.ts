import "dotenv/config";
import pg from "pg";

async function main() {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) {
    console.log("DATABASE_URL is missing in .env");
    return;
  }
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(`
      create table if not exists notifications (
        id bigserial primary key,
        tenant_id bigint not null references organizations(id) on delete restrict on update cascade,
        user_id bigint not null references users(id) on delete cascade on update cascade,
        type text not null,
        title text not null,
        body text not null,
        data jsonb not null default '{}'::jsonb,
        read_at timestamptz,
        push_sent_at timestamptz,
        created_at timestamptz not null default current_timestamp
      );
    `);
    await client.query(`
      create index if not exists notifications_user_created_idx
        on notifications (tenant_id, user_id, created_at desc);
    `);
    await client.query(`
      create index if not exists notifications_user_unread_idx
        on notifications (tenant_id, user_id) where read_at is null;
    `);

    await client.query(`
      create table if not exists device_push_tokens (
        id bigserial primary key,
        tenant_id bigint not null references organizations(id) on delete restrict on update cascade,
        user_id bigint not null references users(id) on delete cascade on update cascade,
        token text not null,
        platform text,
        created_at timestamptz not null default current_timestamp,
        updated_at timestamptz not null default current_timestamp
      );
    `);
    await client.query(`
      create unique index if not exists device_push_tokens_token_key on device_push_tokens (token);
    `);
    await client.query(`
      create index if not exists device_push_tokens_user_idx on device_push_tokens (tenant_id, user_id);
    `);

    const a = await client.query("select count(*)::int as n from notifications");
    const b = await client.query("select count(*)::int as n from device_push_tokens");
    console.log(`OK - notifications (${a.rows[0].n} rows) and device_push_tokens (${b.rows[0].n} rows) are ready.`);
  } catch (e) {
    console.log("FAILED:", (e as Error).message);
  } finally {
    await client.end().catch(() => {});
  }
}

main();