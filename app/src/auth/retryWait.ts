/**
 * "in 12 minutes" for a 429, from the server's Retry-After value. Formatting only: the number is never hard-coded
 * and the app decides nothing about the wait (Figma note 229:3687). Under a minute reads "in a minute".
 * Returns null when the server gave no usable value.
 */
export function formatRetryWait(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds <= 60) return 'in a minute';
  return `in ${Math.ceil(seconds / 60)} minutes`;
}
