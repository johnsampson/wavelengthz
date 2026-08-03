import { describe, it, expect } from 'vitest';
import { computeAge } from '../../src/lib/age';

describe('computeAge', () => {
  it('computes full years elapsed when birthday has already passed this year', () => {
    const dob = '2000-01-15';
    const now = new Date('2026-06-01').getTime();
    expect(computeAge(dob, now)).toBe(26);
  });

  it('does not count the current year if the birthday has not occurred yet', () => {
    const dob = '2000-12-31';
    const now = new Date('2026-06-01').getTime();
    expect(computeAge(dob, now)).toBe(25);
  });

  it('returns exactly 18 on the 18th birthday itself', () => {
    const dob = '2008-06-01';
    const now = new Date('2026-06-01').getTime();
    expect(computeAge(dob, now)).toBe(18);
  });
});
