import { createTeamCopy } from '../auth/copy';

export type CreateTeamField = 'name' | 'timeZone';
export type CreateTeamFieldErrors = Partial<Record<CreateTeamField, string>>;
export const createTeamFieldOrder: readonly CreateTeamField[] = ['name', 'timeZone'];

/** Presence only, on tap (same rule as sign-up). The length limit and the list of valid zones are the server's decision. */
export function validateCreateTeam(input: { name: string; timeZone: string | null }): CreateTeamFieldErrors {
  const errors: CreateTeamFieldErrors = {};
  if (input.name.trim() === '') errors.name = createTeamCopy.nameRequired;
  if (input.timeZone === null || input.timeZone === '') errors.timeZone = createTeamCopy.timeZoneRequired;
  return errors;
}
