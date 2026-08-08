import { describe, it, expect } from 'vitest';
import { computeAge, isMutuallyWithinAgeRange } from '../../src/lib/age';

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

describe('isMutuallyWithinAgeRange', () => {
  const now = new Date('2026-06-01').getTime();
  // 20 years old as of `now`.
  const dob20 = '2006-01-01';
  // 25 years old as of `now`.
  const dob25 = '2001-01-01';
  // 30 years old as of `now`.
  const dob30 = '1996-01-01';
  // 45 years old as of `now`.
  const dob45 = '1981-01-01';

  it('is true when each side is within the other\'s range', () => {
    const a = { date_of_birth: dob25, age_min: 18, age_max: 35 };
    const b = { date_of_birth: dob30, age_min: 20, age_max: 40 };
    expect(isMutuallyWithinAgeRange(a, b, now)).toBe(true);
  });

  it('is false when the candidate is outside the viewer\'s own range, even if the viewer is within the candidate\'s', () => {
    const viewer = { date_of_birth: dob20, age_min: 18, age_max: 25 };
    const candidate = { date_of_birth: dob45, age_min: 18, age_max: 100 };
    expect(isMutuallyWithinAgeRange(viewer, candidate, now)).toBe(false);
  });

  it('is false when the viewer is outside the candidate\'s own stated range, even if the candidate is within the viewer\'s -- the actual reported gap', () => {
    // A 20-year-old who set a narrow preference (18-25) must not be shown
    // to, or matched with, a 45-year-old just because that 45-year-old's
    // own range happens to be wide enough to include 20-year-olds.
    const narrowYoungPerson = { date_of_birth: dob20, age_min: 18, age_max: 25 };
    const wideRangedOlderPerson = { date_of_birth: dob45, age_min: 18, age_max: 100 };
    expect(isMutuallyWithinAgeRange(wideRangedOlderPerson, narrowYoungPerson, now)).toBe(false);
  });

  it('an unknown date_of_birth only skips that side\'s own age being checked, not the check of the other side against their stated range', () => {
    // Both ranges wide here specifically to isolate "DOB unknown, so MY age
    // can't be checked against their range" from "their age still gets
    // checked against MY stated range regardless of whether my own DOB is
    // known" -- the latter is intentional (see the "narrow-young" scenario
    // above), not something an unknown DOB should also bypass.
    const unknownDob = { date_of_birth: null, age_min: 18, age_max: 100 };
    const known = { date_of_birth: dob45, age_min: 18, age_max: 100 };
    expect(isMutuallyWithinAgeRange(unknownDob, known, now)).toBe(true);
    expect(isMutuallyWithinAgeRange(known, unknownDob, now)).toBe(true);
  });
});
