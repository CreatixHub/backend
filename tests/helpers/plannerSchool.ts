import { db } from '../../src/db';
import { classes, plannerLessons, sections, staff, subjects, timeSlots } from '../../src/db/schema';
import type { TenantContext } from '../../src/lib/tenant';
import { type Problem } from '../../src/modules/timetable-planner/engine/engine';
import { changePlanner } from '../../src/modules/timetable-planner/planner.settings';
import { plannerSampleProblem, plannerSampleSubjects } from './plannerSample';

/** Install the planner curriculum in a new school and year. Shared with the staging seed script. */
export function seedPlannerCurriculum(tenant: TenantContext, yearId: bigint, sample = plannerSampleProblem()) {
  return changePlanner(tenant, yearId, async (tx) => {
    const tenantId = tenant.id;
    const [grade] = await tx.insert(classes).values({ tenantId, gradeLevel: 5, name: 'Grade 5', code: 'G5' }).returning();
    const sectionRows = await tx.insert(sections).values(sample.sections.map(({ name, capacity }) => ({
      tenantId, classId: grade.id, name, capacity: capacity ?? 30,
    }))).returning();
    const subjectRows = await tx.insert(subjects).values(plannerSampleSubjects.map(({ code, name }) => ({
      tenantId, code, name, subjectType: 'core',
    }))).returning();
    const sectionIds = new Map(sectionRows.map((row, index) => [sample.sections[index].id, row.id]));
    const subjectIds = new Map(subjectRows.map((row, index) => [plannerSampleSubjects[index].id, row.id]));
    const staffRows = await tx.insert(staff).values(sample.staff.map((teacher, index) => ({
      tenantId, employeeNo: `T${index + 1}`, fullName: teacher.name, firstName: teacher.name.split(' ')[0],
      lastName: teacher.name.split(' ').slice(1).join(' '), staffType: 'teaching', employmentType: 'full_time',
      joinedOn: '2026-06-01', primarySubjectId: subjectIds.get(teacher.primarySubjectId ?? '') ?? null,
      maxPeriodsPerWeek: teacher.maxPeriodsPerWeek ?? null,
    }))).returning();
    const teacherIds = new Map(staffRows.map((row, index) => [sample.staff[index].id, row.id]));
    const lessonRows = await tx.insert(plannerLessons).values(sample.lessons.map((lesson) => ({
      tenantId, academicYearId: yearId, subjectId: subjectIds.get(lesson.subjectId ?? '') ?? null,
      activityName: lesson.activityName, syncGroup: lesson.syncGroup,
      sectionIds: lesson.sectionIds.map((id) => sectionIds.get(id)!),
      parts: lesson.parts.map((part) => ({
        ...part, teacherIds: part.teacherIds.map((id) => teacherIds.get(id)!.toString()),
      })),
    }))).returning();

    return {
      data: {
        classId: grade.id.toString(),
        sectionIds: sectionRows.map((row) => row.id.toString()),
        subjectIds: subjectRows.map((row) => row.id.toString()),
        teacherIds: staffRows.map((row) => row.id.toString()),
        lessonIds: lessonRows.map((row) => row.id.toString()),
      },
      changes: {
        bell: sample.bell,
        rules: { defaults: sample.rules.defaults ?? {}, teachers: {}, sections: {} },
      },
    };
  });
}

export async function createPlannerSchool(tag: string, sample?: Problem) {
  const { currentAcademicYearId, signupAndLogin, uniqueSlug } = await import('../helpers');
  const { agent, switchOrganization } = await signupAndLogin(tag);
  const slug = uniqueSlug(tag);
  const name = `${tag} School`;
  const response = await agent.post('/api/organizations').send({ name, slug, timezone: 'Asia/Kolkata' });
  if (response.status !== 201) throw new Error(`Creating ${slug} returned ${response.status}: ${response.body.message}`);
  const switchResponse = await switchOrganization(slug);
  if (switchResponse.status !== 200) throw new Error(`Switching to ${slug} returned ${switchResponse.status}`);
  const tenant: TenantContext = {
    id: BigInt(response.body.data.id), name, slug, roles: ['owner'], permissions: new Set(['*']),
  };
  const academicYearId = await currentAcademicYearId(agent);
  const curriculum = await seedPlannerCurriculum(tenant, BigInt(academicYearId), sample);
  return { agent, tenant, tenantId: tenant.id, academicYearId, ...curriculum };
}

/** Two sections, one teacher, one lesson per section: small enough to publish in a blink. */
export function smallPlannerSample(): Problem {
  const sample = plannerSampleProblem();
  const teacher = sample.staff[0];
  sample.sections = sample.sections.slice(0, 2);
  sample.staff = [teacher];
  sample.lessons = sample.sections.map((section, index) => ({
    ...sample.lessons.find((lesson) => lesson.sectionIds.includes(section.id) && lesson.subjectId === teacher.primarySubjectId)!,
    id: String(index + 1),
    parts: [{ ...sample.lessons[0].parts[0], pattern: [{ count: 1, length: 1 }] }],
  }));
  return sample;
}

/** One section with one lesson taught by two teachers together in one period a week. */
export function teamTaughtPlannerSample(): Problem {
  const sample = plannerSampleProblem();
  const [first, second] = sample.staff;
  sample.sections = sample.sections.slice(0, 1);
  sample.staff = [first, second];
  const template = sample.lessons.find((lesson) => lesson.sectionIds.includes('1') && lesson.subjectId === first.primarySubjectId)!;
  sample.lessons = [{
    ...template, id: '1',
    parts: [{ ...template.parts[0], teacherIds: [first.id, second.id], mode: 'together', pattern: [{ count: 1, length: 1 }] }],
  }];
  return sample;
}

/** An extra section of the school's class that has no lessons in the plan, so a publication leaves it alone. */
export async function addPlannerSection(tenantId: bigint, classId: string, name: string) {
  const [row] = await db.insert(sections).values({ tenantId, classId: BigInt(classId), name, capacity: 30 }).returning();
  return row.id;
}

/** Insert the sample bell's periods as time slots, as a school that already ran a manual timetable would have them. */
export async function insertPlannerBellSlots(tenantId: bigint) {
  const bell = plannerSampleProblem().bell.dayTypes[0];
  return db.insert(timeSlots).values(bell.periods.map((period, index) => ({
    tenantId, name: period.name, dayType: bell.id, days: bell.days, sequence: index + 1,
    startsAt: `${period.startsAt}:00`, endsAt: `${period.endsAt}:00`, isBreak: false, durationMinutes: 40,
  }))).returning();
}

/** One lesson shared by two classes in the same period with one teacher (a combined lesson). */
export function combinedPlannerSample(): Problem {
  const sample = plannerSampleProblem();
  const teacher = sample.staff[0];
  sample.sections = sample.sections.slice(0, 2);
  sample.staff = [teacher];
  const template = sample.lessons.find((lesson) => lesson.subjectId === teacher.primarySubjectId)!;
  sample.lessons = [{
    ...template, id: '1', sectionIds: sample.sections.map((section) => section.id),
    parts: [{ ...template.parts[0], teacherIds: [teacher.id], pattern: [{ count: 1, length: 1 }] }],
  }];
  return sample;
}
