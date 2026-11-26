import { describe, expect, it } from 'vitest';
import { defaultYearFor } from '../src/modules/academic-years/yearName';

// Pure helper, no database: the first academic year a school gets.
describe('defaultYearFor', () => {
  it('names the year after the creation year and runs 1 June to 31 May', () => {
    expect(defaultYearFor(new Date('2026-11-24T10:00:00Z'))).toEqual({
      name: '2026-27',
      startsOn: '2026-06-01',
      endsOn: '2027-05-31',
    });
  });

  it('zero-pads the short end year', () => {
    expect(defaultYearFor(new Date('2008-02-01T00:00:00Z')).name).toBe('2008-09');
  });

  it('rolls over the century', () => {
    const y = defaultYearFor(new Date('2099-07-01T00:00:00Z'));
    expect(y.name).toBe('2099-00');
    expect(y.endsOn).toBe('2100-05-31');
  });

  it('uses the UTC calendar year, not the server time zone', () => {
    expect(defaultYearFor(new Date('2026-12-31T23:30:00Z')).name).toBe('2026-27');
    expect(defaultYearFor(new Date('2027-01-01T00:30:00Z')).name).toBe('2027-28');
  });
});
