import { Router } from 'express';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { admissions, classes, students } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { ok } from '../../lib/respond';
import type { TenantContext } from '../../lib/tenant';
import { currentTenant } from '../../middleware/authenticate';

// YEAR-END PROMOTION. A student's class lives on their admission record (admissions.class_id, linked by
// admissions.student_id), so "promote" = change admissions.class_id to the next grade_level class.
// "Graduate" = students.status 'alumni' (every active list already filters status = 'active').
// Whole run is ONE transaction. Administrators only.

export const promotionRouter = Router();

type Exec = typeof db;
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);

// ASSUMPTION: the value in memberships.status that blocks login.
const BLOCKED_MEMBERSHIP_STATUS = 'inactive';

function requireAdmin(tenant: TenantContext) {
  if (!(tenant.permissions.has('*') || tenant.roles.includes('admin'))) {
    throw new HttpError(403, 'Only an administrator can run promotion');
  }
}

const big = (v: bigint | number | string | null | undefined) => sql`${v === null || v === undefined ? null : String(v)}::bigint`;
const idList = (ids: Array<bigint | number>) => sql.join(ids.map((i) => big(i)), sql`, `);
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

const yearLabelSchema = z.string().trim().min(4, 'Enter a year label like 2026-27').max(20);
const displayName = sql<string>`coalesce(nullif(trim(${students.fullName}), ''), trim(${students.firstName} || ' ' || ${students.lastName}))`;

async function loadClasses(ex: Exec, tenantId: bigint) {
  const rows = await ex
    .select({ id: classes.id, name: classes.name, gradeLevel: classes.gradeLevel })
    .from(classes)
    .where(and(eq(classes.tenantId, tenantId), isNull(classes.deletedAt), eq(classes.status, 'active')))
    .orderBy(asc(classes.gradeLevel), asc(classes.id));
  const seen = new Set<number>();
  for (const c of rows) {
    if (seen.has(Number(c.gradeLevel))) {
      throw new HttpError(409, `Two active classes share grade level ${c.gradeLevel}. Fix this before promoting (the next class would be ambiguous).`);
    }
    seen.add(Number(c.gradeLevel));
  }
  return rows;
}

async function loadEnrolled(ex: Exec, tenantId: bigint) {
  return ex
    .select({
      id: students.id,
      name: displayName,
      admissionNo: students.admissionNo,
      rollNo: students.rollNo,
      userId: students.userId,
      admissionId: admissions.id,
      classId: admissions.classId,
    })
    .from(students)
    .innerJoin(admissions, eq(admissions.studentId, students.id))
    .where(
      and(
        eq(students.tenantId, tenantId),
        eq(admissions.tenantId, tenantId),
        eq(students.status, 'active'),
        isNull(students.deletedAt),
        isNull(admissions.deletedAt),
      ),
    )
    .orderBy(asc(sql`lower(${displayName})`), asc(students.id));
}

async function yearAlreadyRun(ex: Exec, tenantId: bigint, yearLabel: string) {
  const r = rowsOf(
    await ex.execute(
      sql`select 1 from promotion_batches where tenant_id = ${big(tenantId)} and year_label = ${yearLabel} and undone_at is null limit 1`,
    ),
  );
  return r.length > 0;
}

// GET /api/promotion/preview?yearLabel=2026-27
promotionRouter.get('/preview', async (req, res) => {
  const tenant = currentTenant(req);
  requireAdmin(tenant);
  const q = z.object({ yearLabel: yearLabelSchema }).parse(req.query);
  const cls = await loadClasses(db, tenant.id);
  const enrolled = await loadEnrolled(db, tenant.id);
  const out = cls.map((c, i) => ({
    id: String(c.id),
    name: c.name,
    gradeLevel: Number(c.gradeLevel),
    isFinal: i === cls.length - 1,
    nextClassName: i < cls.length - 1 ? cls[i + 1].name : 'Alumni',
    students: enrolled
      .filter((s) => s.classId === c.id)
      .map((s) => ({ id: String(s.id), name: s.name, admissionNo: s.admissionNo, rollNo: s.rollNo })),
  }));
  ok(res, { yearLabel: q.yearLabel, alreadyRun: await yearAlreadyRun(db, tenant.id, q.yearLabel), classes: out });
});

// POST /api/promotion/run  { yearLabel, stayStudentIds: [], blockAlumniLogin: true }
promotionRouter.post('/run', async (req, res) => {
  const tenant = currentTenant(req);
  requireAdmin(tenant);
  const body = z
    .object({
      yearLabel: yearLabelSchema,
      stayStudentIds: z.array(z.coerce.bigint().positive()).default([]),
      blockAlumniLogin: z.boolean().default(true),
    })
    .parse(req.body);
  const stay = new Set(body.stayStudentIds.map(String));
  const runBy = (req as any).user?.id ?? null;

  let summary: { batchId: string; promoted: number; stayed: number; graduated: number };
  try {
    summary = await db.transaction(async (tx0) => {
      const tx = tx0 as unknown as Exec;
      if (await yearAlreadyRun(tx, tenant.id, body.yearLabel)) {
        throw new HttpError(409, `Promotion for ${body.yearLabel} has already been run`);
      }
      const cls = await loadClasses(tx, tenant.id);
      if (cls.length === 0) throw new HttpError(409, 'No active classes found');
      const enrolled = await loadEnrolled(tx, tenant.id);
      const classIdx = new Map(cls.map((c, i) => [String(c.id), i]));

      type Item = {
        studentId: bigint; admissionId: bigint; fromClass: bigint; toClass: bigint | null;
        action: 'promote' | 'stay' | 'graduate'; rollBefore: string | null; userId: bigint | null; memPrev: string | null;
      };
      const items: Item[] = [];
      for (let i = cls.length - 1; i >= 0; i--) {
        const c = cls[i];
        const isFinal = i === cls.length - 1;
        for (const s of enrolled.filter((e) => classIdx.get(String(e.classId)) === i)) {
          const staying = stay.has(String(s.id));
          items.push({
            studentId: s.id, admissionId: s.admissionId, fromClass: c.id,
            toClass: staying ? c.id : isFinal ? null : cls[i + 1].id,
            action: staying ? 'stay' : isFinal ? 'graduate' : 'promote',
            rollBefore: s.rollNo, userId: s.userId, memPrev: null,
          });
        }
      }
      const promote = items.filter((x) => x.action === 'promote');
      const graduate = items.filter((x) => x.action === 'graduate');
      const stayed = items.filter((x) => x.action === 'stay');

      if (body.blockAlumniLogin) {
        const uids = graduate.map((g) => g.userId).filter((u): u is bigint => u !== null);
        if (uids.length) {
          const ms = rowsOf(
            await tx.execute(sql`select user_id::text as user_id, status from memberships where tenant_id = ${big(tenant.id)} and user_id in (${idList(uids)})`),
          );
          const prev = new Map(ms.map((m) => [String(m.user_id), m.status as string]));
          for (const g of graduate) if (g.userId !== null) g.memPrev = prev.get(String(g.userId)) ?? null;
        }
      }

      const [b] = rowsOf(
        await tx.execute(sql`
          insert into promotion_batches (tenant_id, year_label, run_by, promoted_count, stayed_count, graduated_count, block_alumni_login)
          values (${big(tenant.id)}, ${body.yearLabel}, ${big(runBy)}, ${promote.length}, ${stayed.length}, ${graduate.length}, ${body.blockAlumniLogin})
          returning id::text as id`),
      );

      for (const part of chunk(items, 300)) {
        await tx.execute(sql`
          insert into promotion_items (batch_id, tenant_id, student_id, admission_id, from_class_id, to_class_id, action, roll_before, user_id, membership_prev)
          values ${sql.join(
            part.map((x) => sql`(${big(b.id)}, ${big(tenant.id)}, ${big(x.studentId)}, ${big(x.admissionId)}, ${big(x.fromClass)}, ${big(x.toClass)}, ${x.action}, ${x.rollBefore}::text, ${big(x.userId)}, ${x.memPrev}::text)`),
            sql`, `,
          )}`);
      }

      const byTarget = new Map<string, Item[]>();
      for (const p of promote) byTarget.set(String(p.toClass), [...(byTarget.get(String(p.toClass)) ?? []), p]);
      for (const [target, list] of byTarget) {
        await tx
          .update(admissions)
          .set({ classId: BigInt(target), updatedAt: new Date() })
          .where(and(eq(admissions.tenantId, tenant.id), inArray(admissions.id, list.map((x) => x.admissionId))));
      }
      if (promote.length) {
        await tx.update(students).set({ rollNo: null }).where(and(eq(students.tenantId, tenant.id), inArray(students.id, promote.map((x) => x.studentId))));
      }

      if (graduate.length) {
        await tx
          .update(students)
          .set({ status: 'alumni', leftOn: sql`current_date` as any, leftReason: 'Graduated', rollNo: null })
          .where(and(eq(students.tenantId, tenant.id), inArray(students.id, graduate.map((x) => x.studentId))));
        if (body.blockAlumniLogin) {
          const uids = graduate.map((g) => g.userId).filter((u): u is bigint => u !== null);
          if (uids.length) {
            await tx.execute(sql`update memberships set status = ${BLOCKED_MEMBERSHIP_STATUS}, updated_at = now() where tenant_id = ${big(tenant.id)} and user_id in (${idList(uids)})`);
          }
        }
      }
      return { batchId: b.id as string, promoted: promote.length, stayed: stayed.length, graduated: graduate.length };
    });
  } catch (e: any) {
    if ((e?.code ?? e?.cause?.code) === '23505') throw new HttpError(409, `Promotion for ${body.yearLabel} has already been run`);
    throw e;
  }
  ok(res, summary);
});

// GET /api/promotion/batches
promotionRouter.get('/batches', async (req, res) => {
  const tenant = currentTenant(req);
  requireAdmin(tenant);
  const rows = rowsOf(
    await db.execute(sql`
      select id::text as id, year_label, promoted_count, stayed_count, graduated_count, block_alumni_login, created_at, undone_at, run_by::text as run_by
      from promotion_batches where tenant_id = ${big(tenant.id)} order by id desc`),
  );
  ok(res, rows);
});

// GET /api/promotion/batches/:id/items
promotionRouter.get('/batches/:id/items', async (req, res) => {
  const tenant = currentTenant(req);
  requireAdmin(tenant);
  const id = z.coerce.bigint().positive().parse(req.params.id);
  const rows = rowsOf(
    await db.execute(sql`
      select pi.student_id::text as student_id, st.admission_no,
             coalesce(nullif(trim(st.full_name), ''), trim(st.first_name || ' ' || st.last_name)) as name,
             pi.action, fc.name as from_class, tc.name as to_class
      from promotion_items pi
      join students st on st.id = pi.student_id
      join classes fc on fc.id = pi.from_class_id
      left join classes tc on tc.id = pi.to_class_id
      where pi.batch_id = ${big(id)} and pi.tenant_id = ${big(tenant.id)}
      order by fc.grade_level, lower(coalesce(nullif(trim(st.full_name), ''), st.first_name))`),
  );
  ok(res, rows);
});

// POST /api/promotion/undo
promotionRouter.post('/undo', async (req, res) => {
  const tenant = currentTenant(req);
  requireAdmin(tenant);
  const result = await db.transaction(async (tx) => {
    const [b] = rowsOf(
      await tx.execute(sql`select id::text as id, year_label from promotion_batches where tenant_id = ${big(tenant.id)} and undone_at is null order by id desc limit 1 for update`),
    );
    if (!b) throw new HttpError(404, 'There is no promotion to undo');
    const B = big(b.id);

    const drift = rowsOf(
      await tx.execute(sql`
        select count(*)::int as n
        from promotion_items pi
        join students s on s.id = pi.student_id
        left join admissions a on a.id = pi.admission_id
        where pi.batch_id = ${B}
          and ((pi.action = 'promote' and a.class_id is distinct from pi.to_class_id)
            or (pi.action = 'graduate' and s.status <> 'alumni'))`),
    )[0]?.n ?? 0;
    if (drift > 0) {
      throw new HttpError(409, `${drift} student(s) were changed after this promotion, so it can't be undone safely`);
    }

    await tx.execute(sql`update admissions a set class_id = pi.from_class_id, updated_at = now() from promotion_items pi where pi.batch_id = ${B} and pi.action = 'promote' and a.id = pi.admission_id`);
    await tx.execute(sql`update students s set roll_no = pi.roll_before, updated_at = now() from promotion_items pi where pi.batch_id = ${B} and pi.action = 'promote' and s.id = pi.student_id`);
    await tx.execute(sql`update students s set status = 'active', left_on = null, left_reason = null, roll_no = pi.roll_before, updated_at = now() from promotion_items pi where pi.batch_id = ${B} and pi.action = 'graduate' and s.id = pi.student_id`);
    await tx.execute(sql`update memberships m set status = pi.membership_prev, updated_at = now() from promotion_items pi where pi.batch_id = ${B} and pi.action = 'graduate' and pi.membership_prev is not null and pi.user_id is not null and m.user_id = pi.user_id and m.tenant_id = ${big(tenant.id)}`);
    await tx.execute(sql`update promotion_batches set undone_at = now() where id = ${B}`);
    return { batchId: b.id as string, yearLabel: b.year_label as string };
  });
  ok(res, result);
});

// GET /api/promotion/alumni?search=&year=2026-27
promotionRouter.get('/alumni', async (req, res) => {
  const tenant = currentTenant(req);
  requireAdmin(tenant);
  const q = z.object({ search: z.string().trim().optional(), year: z.string().trim().optional() }).parse(req.query);
  const like = q.search ? `%${q.search}%` : null;
  const rows = rowsOf(
    await db.execute(sql`
      select s.id::text as id, s.admission_no,
             coalesce(nullif(trim(s.full_name), ''), trim(s.first_name || ' ' || s.last_name)) as name,
             s.left_on, g.year_label, c.name as last_class
      from students s
      left join lateral (
        select pi.from_class_id, pb.year_label
        from promotion_items pi join promotion_batches pb on pb.id = pi.batch_id
        where pi.student_id = s.id and pi.action = 'graduate' and pb.undone_at is null
        order by pb.id desc limit 1
      ) g on true
      left join classes c on c.id = g.from_class_id
      where s.tenant_id = ${big(tenant.id)} and s.status = 'alumni' and s.deleted_at is null
        and (${like}::text is null or s.admission_no ilike ${like}::text
             or coalesce(nullif(trim(s.full_name), ''), trim(s.first_name || ' ' || s.last_name)) ilike ${like}::text)
        and (${q.year ?? null}::text is null or g.year_label = ${q.year ?? null}::text)
      order by g.year_label desc nulls last, lower(s.first_name)`),
  );
  ok(res, rows);
});
