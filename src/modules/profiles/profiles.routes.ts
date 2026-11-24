import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { parseId } from '../../lib/bigint';
import { HttpError } from '../../lib/errors';
import { ok } from '../../lib/respond';
import { currentTenant } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';

// PROFILES: staff directory + class profiles (read only).
export const profilesRouter = Router();

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);
const byName = (a: any, b: any) => String(a.name ?? '').localeCompare(String(b.name ?? ''));

// ---------------------------------------------------------------- staff
profilesRouter.get('/staff', requirePermission('staff.view'), async (req, res) => {
  const tenant = currentTenant(req);
  const rows = rowsOf(
    await db.execute(sql`
      select s.id::text as "id",
             coalesce(nullif(s.full_name, ''), trim(concat_ws(' ', s.first_name, s.last_name))) as "name",
             s.staff_type as "staffType", s.status as "status", s.email as "email", s.phone as "phone",
             s.photo_file_id::text as "photoFileId", s.employee_no as "employeeNo",
             (select string_agg(distinct sub.name, ', ')
                from section_teachers stt join subjects sub on sub.id = stt.subject_id
               where stt.teacher_id = s.id and stt.tenant_id = s.tenant_id) as "subjects",
             (select string_agg(c.name, ', ')
                from class_teachers ct join classes c on c.id = ct.class_id
               where ct.teacher_id = s.id and ct.tenant_id = s.tenant_id) as "classTeacherOf"
      from staff s
      where s.tenant_id = ${String(tenant.id)} and s.deleted_at is null`),
  );
  rows.sort(byName);
  ok(res, rows);
});

const STAFF_KEYS = [
  'employee_no', 'staff_type', 'employment_type', 'status', 'first_name', 'last_name', 'full_name', 'dob', 'gender',
  'blood_group', 'email', 'phone', 'alt_phone', 'address_line1', 'address_line2', 'postal_code', 'qualification',
  'experience_years', 'joined_on', 'emergency_contact_name', 'emergency_contact_phone', 'photo_file_id',
];
const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

profilesRouter.get('/staff/:id', requirePermission('staff.view'), async (req, res) => {
  const tenant = currentTenant(req);
  const id = parseId(req.params.id);
  const j: any = rowsOf(
    await db.execute(
      sql`select to_jsonb(s) as j from staff s where s.id = ${String(id)} and s.tenant_id = ${String(tenant.id)} and s.deleted_at is null`,
    ),
  )[0]?.j;
  if (!j) throw new HttpError(404, 'Staff member not found');
  const staff: Record<string, unknown> = { id: String(id) };
  for (const k of STAFF_KEYS) if (k in j) staff[camel(k)] = k === 'photo_file_id' && j[k] != null ? String(j[k]) : j[k];

  const assignments = rowsOf(
    await db.execute(sql`
      select c.name as "className", sec.name as "sectionName", sub.name as "subjectName"
      from section_teachers st
      join sections sec on sec.id = st.section_id
      join classes c on c.id = sec.class_id
      join subjects sub on sub.id = st.subject_id
      where st.teacher_id = ${String(id)} and st.tenant_id = ${String(tenant.id)} and sec.deleted_at is null
      order by c.grade_level, sec.name, sub.name`),
  );
  const classTeacherOf = rowsOf(
    await db.execute(sql`
      select c.id::text as "id", c.name as "name"
      from class_teachers ct join classes c on c.id = ct.class_id
      where ct.teacher_id = ${String(id)} and ct.tenant_id = ${String(tenant.id)}
      order by c.grade_level`),
  );
  ok(res, { staff, assignments, classTeacherOf });
});

// ---------------------------------------------------------------- classes
profilesRouter.get('/classes', requirePermission('staff.view'), async (req, res) => {
  const tenant = currentTenant(req);
  const rows = rowsOf(
    await db.execute(sql`
      select c.id::text as "id", c.name as "name", c.stream as "stream", c.grade_level as "gradeLevel",
             (select count(distinct a.student_id) from admissions a join students s on s.id = a.student_id
               where a.tenant_id = c.tenant_id and a.class_id = c.id and a.student_id is not null
                 and a.deleted_at is null and s.status = 'active') as "students",
             (select string_agg(sec.name, ', ' order by sec.name) from sections sec
               where sec.class_id = c.id and sec.deleted_at is null) as "sections",
             t.id::text as "teacherId",
             coalesce(nullif(t.full_name, ''), trim(concat_ws(' ', t.first_name, t.last_name))) as "teacherName",
             t.photo_file_id::text as "teacherPhoto"
      from classes c
      left join class_teachers ct on ct.class_id = c.id and ct.tenant_id = c.tenant_id
      left join staff t on t.id = ct.teacher_id
      where c.tenant_id = ${String(tenant.id)} and c.deleted_at is null
      order by c.grade_level, c.name`),
  );
  ok(res, rows.map((r) => ({ ...r, students: Number(r.students) })));
});

profilesRouter.get('/classes/:id', requirePermission('staff.view'), async (req, res) => {
  const tenant = currentTenant(req);
  const id = parseId(req.params.id);
  const t = String(tenant.id);
  const head = rowsOf(
    await db.execute(sql`
      select c.id::text as "id", c.name as "name", c.stream as "stream",
             t.id::text as "teacherId",
             coalesce(nullif(t.full_name, ''), trim(concat_ws(' ', t.first_name, t.last_name))) as "teacherName",
             t.photo_file_id::text as "teacherPhoto", t.phone as "teacherPhone"
      from classes c
      left join class_teachers ct on ct.class_id = c.id and ct.tenant_id = c.tenant_id
      left join staff t on t.id = ct.teacher_id
      where c.id = ${String(id)} and c.tenant_id = ${t} and c.deleted_at is null`),
  )[0];
  if (!head) throw new HttpError(404, 'Class not found');

  const sections = rowsOf(
    await db.execute(sql`
      select sec.id::text as "id", sec.name as "name", sec.capacity as "capacity"
      from sections sec where sec.class_id = ${String(id)} and sec.tenant_id = ${t} and sec.deleted_at is null
      order by sec.name`),
  );
  const subjectTeachers = rowsOf(
    await db.execute(sql`
      select sec.name as "sectionName", sub.name as "subjectName", tt.id::text as "teacherId",
             coalesce(nullif(tt.full_name, ''), trim(concat_ws(' ', tt.first_name, tt.last_name))) as "teacherName",
             tt.photo_file_id::text as "teacherPhoto"
      from section_teachers st
      join sections sec on sec.id = st.section_id
      join subjects sub on sub.id = st.subject_id
      join staff tt on tt.id = st.teacher_id
      where sec.class_id = ${String(id)} and st.tenant_id = ${t} and sec.deleted_at is null
      order by sec.name, sub.name`),
  );
  const students = rowsOf(
    await db.execute(sql`
      select distinct on (s.id) s.id::text as "id",
             coalesce(nullif(s.full_name, ''), trim(concat_ws(' ', s.first_name, s.last_name))) as "name",
             s.roll_no as "rollNo", s.admission_no as "admissionNo", s.photo_file_id::text as "photoFileId", s.gender as "gender"
      from admissions a join students s on s.id = a.student_id
      where a.tenant_id = ${t} and a.class_id = ${String(id)} and a.student_id is not null
        and a.deleted_at is null and s.status = 'active'
      order by s.id`),
  );
  students.sort((a, b) => {
    const ra = parseInt(a.rollNo ?? '', 10);
    const rb = parseInt(b.rollNo ?? '', 10);
    if (!isNaN(ra) && !isNaN(rb) && ra !== rb) return ra - rb;
    return byName(a, b);
  });
  ok(res, { class: head, sections, subjectTeachers, students });
});