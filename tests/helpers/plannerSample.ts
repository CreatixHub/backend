import type { Problem } from '../../src/modules/timetable-planner/engine/engine';

const subjects = [
  ['ENG', 'English', 'Asha Kumar'],
  ['MAT', 'Mathematics', 'Bina Das'],
  ['SCI', 'Science', 'Chandra Rao'],
  ['HIS', 'History', 'Divya Shah'],
  ['GEO', 'Geography', 'Esha Patel'],
  ['COM', 'Computing', 'Farah Sen'],
  ['ART', 'Art', 'Gita Nair'],
] as const;

export const plannerSampleSubjects = subjects.map(([code, name], index) => ({ id: String(index + 1), code, name }));

const formatTime = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function plannerSampleProblem(): Problem {
  const days = [1, 2, 3, 4, 5];
  const sections = ['A', 'B', 'C', 'D', 'E'].map((name, index) => ({
    id: String(index + 1), name, className: 'Grade 5', capacity: 30,
  }));
  const staff = subjects.map(([, , name], index) => {
    const subjectId = plannerSampleSubjects[index].id;
    return { id: String(index + 1), name, primarySubjectId: subjectId, subjectIds: [subjectId], maxPeriodsPerWeek: 35 };
  });
  return {
    days,
    bell: {
      weekType: 'weekly',
      dayTypes: [{
        id: 'usual', name: 'School day', days,
        periods: Array.from({ length: 8 }, (_, index) => ({
          id: `p${index + 1}`, name: `Period ${index + 1}`,
          startsAt: formatTime(540 + index * 40), endsAt: formatTime(580 + index * 40), isBreak: false,
        })),
      }],
    },
    sections,
    staff,
    rooms: [],
    availability: {},
    rules: { defaults: {
      teacherMinFreePerDay: { value: 1, level: 'critical' },
      // Each class has six weekly periods in five subjects, so some days must repeat a subject.
      subjectSpread: { value: 1, level: 'high' },
    } },
    lessons: sections.flatMap((section, sectionIndex) => staff.map((teacher, teacherIndex) => {
      const subject = plannerSampleSubjects[teacherIndex];
      const count = teacherIndex === sectionIndex || teacherIndex === (sectionIndex + 1) % sections.length ? 5 : 6;
      return {
        id: String(sectionIndex * staff.length + teacherIndex + 1),
        sectionIds: [section.id], subjectId: subject.id, subjectName: subject.name,
        parts: [{ id: 'main', teacherIds: [teacher.id], mode: 'together', pattern: [{ count, length: 1 }], room: { type: 'none' } }],
      };
    })),
  };
}
