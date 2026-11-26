// For one lesson: the week of each teacher who is on it, and of each other teacher who can teach its subject.
// Every period is free, busy (teaching another class) or blocked (a day off set in the planner's availability).
import type { BlockedSlot, Problem, Schedule } from './engine';

type PeriodState = { no: number; state: 'free' | 'busy' | 'blocked'; with?: string };
export interface TeacherWeek {
  id: string;
  name: string;
  role: 'assigned' | 'primary' | 'additional';
  planned: number;
  max: number | null;
  atMax: boolean;
  days: { day: number; periods: PeriodState[] }[];
}
export interface TeacherAvailability {
  blockId: string;
  subjectId: string | null;
  teachers: TeacherWeek[];
}

const sectionLabel = (sections: Problem['sections'], id: string) => {
  const s = sections.find((x) => x.id === id);
  return s ? `${s.className ? `${s.className} ` : ''}${s.name}`.trim() : String(id);
};

export function buildTeacherAvailability({
  problem,
  schedule,
  blockId,
  availability,
  plannedByTeacher,
}: {
  problem: Problem;
  schedule: Schedule;
  blockId: string;
  availability?: Problem['availability'];
  plannedByTeacher: Map<string, number>;
}): TeacherAvailability {
  const block = schedule.blocks.get(blockId);
  const subjectId: string | null = block.units.find((u: { subjectId?: string }) => u.subjectId)?.subjectId ?? null;
  const assigned: string[] = [...new Set<string>(block.units.flatMap((u: { teacherIds: string[] }) => u.teacherIds))];
  const staff = new Map(problem.staff.map((s) => [String(s.id), s]));

  const others = subjectId
    ? problem.staff
        .filter((s) => !assigned.includes(s.id) && (s.subjectIds || []).includes(subjectId))
        .sort(
          (a, b) =>
            Number(b.primarySubjectId === subjectId) - Number(a.primarySubjectId === subjectId) ||
            a.name.localeCompare(b.name),
        )
    : [];

  // Who is teaching what, when, apart from the lesson being looked at.
  const taught = new Map<string, string>();
  for (const entry of schedule.entries()) {
    if (entry.blockId === blockId) continue;
    for (const teacherId of entry.teacherIds) {
      for (let k = 0; k < entry.length; k += 1) {
        taught.set(`${teacherId}|${entry.day}|${entry.startNo + k}`, sectionLabel(problem.sections, entry.sectionId));
      }
    }
  }

  const weekOf = (teacherId: string) => {
    const blocked = new Set((availability?.staff?.[teacherId] || []).map((b: BlockedSlot) => `${b.day}|${b.period}`));
    return [...schedule.periodsByDay.entries()].map(([day, periods]: [number, { no: number }[]]) => ({
      day,
      periods: periods.map(({ no }): PeriodState => {
        if (blocked.has(`${day}|${no}`)) return { no, state: 'blocked' };
        const busyWith = taught.get(`${teacherId}|${day}|${no}`);
        return busyWith ? { no, state: 'busy', with: busyWith } : { no, state: 'free' };
      }),
    }));
  };

  const describe = (teacherId: string, role: TeacherWeek['role']): TeacherWeek => {
    const member = staff.get(String(teacherId));
    const planned = plannedByTeacher.get(teacherId) ?? 0;
    const max = Number.isInteger(member?.maxPeriodsPerWeek) ? (member?.maxPeriodsPerWeek as number) : null;
    return { id: teacherId, name: member?.name ?? String(teacherId), role, planned, max, atMax: max !== null && planned >= max, days: weekOf(teacherId) };
  };

  return {
    blockId,
    subjectId,
    teachers: [
      ...assigned.filter((id) => staff.has(String(id))).map((id) => describe(id, 'assigned')),
      ...others.map((s) => describe(s.id, s.primarySubjectId === subjectId ? 'primary' : 'additional')),
    ],
  };
}
