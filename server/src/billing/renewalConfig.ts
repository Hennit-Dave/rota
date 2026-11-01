// Renewal settings (ADR 0031). The grace period is a CONFIG value (money.md): the number of days a team whose renewal failed keeps full access before it becomes
// read-only. Dave chose 7 (2026-11-01); RENEWAL_GRACE_DAYS changes it for a run (the proofs, the tests), and nothing else in the code names a number of days.
type Env = Record<string, string | undefined>;

export const DEFAULT_GRACE_DAYS = 7;

export interface RenewalConfig {
  graceDays: number;
}

export function loadRenewalConfig(env: Env = process.env): RenewalConfig {
  const raw = env.RENEWAL_GRACE_DAYS;
  if (raw === undefined || raw === '') return { graceDays: DEFAULT_GRACE_DAYS };
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) throw new Error(`RENEWAL_GRACE_DAYS must be a whole number of days from 1 to 999, got "${raw}"`);
  return { graceDays: Number(raw) };
}

const DAY_MS = 86_400_000;

/** When the grace period ends: exactly `graceDays` whole days after the first failure. Fixed at that moment and never extended by a retry. */
export function graceEndsAt(failedAt: Date, graceDays: number): Date {
  return new Date(failedAt.getTime() + graceDays * DAY_MS);
}
