export function computeAge(dateOfBirth: string, nowMs: number): number {
  const dob = new Date(dateOfBirth);
  const now = new Date(nowMs);
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  const dayDiff = now.getUTCDate() - dob.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age -= 1;
  }
  return age;
}

export interface AgePreferences {
  date_of_birth: string | null;
  age_min: number;
  age_max: number;
}

/**
 * Mutual age-range check: each side's stated range must actually include
 * the other's real age, not just the caller's own range checked against the
 * other person. A one-directional check (only "is the candidate within MY
 * range") lets someone who set a narrow range for their own safety --
 * e.g. an 18-year-old preferring to see 18-25 -- still be shown to, or
 * matched with, someone far outside it, as long as that OTHER person's own
 * range happened to be wide enough to include them.
 *
 * Unknown date_of_birth on either side never excludes that side's check --
 * there's no age to compare. Every real onboarded account has
 * date_of_birth set (enforced at onboarding); this only matters for
 * legacy/malformed rows.
 */
export function isMutuallyWithinAgeRange(a: AgePreferences, b: AgePreferences, nowMs: number): boolean {
  if (a.date_of_birth != null) {
    const ageA = computeAge(a.date_of_birth, nowMs);
    if (ageA < b.age_min || ageA > b.age_max) return false;
  }
  if (b.date_of_birth != null) {
    const ageB = computeAge(b.date_of_birth, nowMs);
    if (ageB < a.age_min || ageB > a.age_max) return false;
  }
  return true;
}
