// The default academic year a new school starts with. Pure (no database), so it is unit-tested on its own.
//
// SIMPLE DEFAULT, on purpose: the year is named after the calendar year the school is created in ("2026-27"),
// starts on 1 June of that year and ends on 31 May of the next. A school whose year runs differently edits the
// dates (PATCH /api/academic-years/:id) or creates its own years. The same rule is used by migration
// 0019_academic_years.sql for schools that already exist, so keep the two in step.
export interface DefaultYear {
  name: string; // "2026-27"
  startsOn: string; // "2026-06-01"
  endsOn: string; // "2027-05-31"
}

export function defaultYearFor(date: Date): DefaultYear {
  const year = date.getUTCFullYear();
  const next = year + 1;
  return {
    name: `${year}-${String(next % 100).padStart(2, '0')}`,
    startsOn: `${year}-06-01`,
    endsOn: `${next}-05-31`,
  };
}
