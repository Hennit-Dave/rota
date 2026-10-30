/** The digits typed in a seats field as a whole number of seats, or null when it is not one. Not an amount: a head count. */
export function seatsFrom(text: string): number | null {
  if (!/^[0-9]{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 ? n : null;
}
