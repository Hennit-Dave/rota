import { dayKeyOf, formatRange, formatShortDate, formatTime } from '../shifts/shiftTime';
import type { Swap, SwapShift } from './swapResponses';
import { swapReviewCopy, swapSentCopy, swapStatusCopy } from './swapCopy';

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

/** `Thu 15 Oct · 09:00 – 17:00` (Figma 8:342) on the TEAM'S clock. */
export function shiftWhen(shift: Pick<SwapShift, 'startsAt' | 'endsAt'>, timeZone: string): string {
  const start = new Date(shift.startsAt);
  return `${formatShortDate(dayKeyOf(start, timeZone))} · ${formatRange(start, new Date(shift.endsAt), timeZone)}`;
}

/** The swap card's heading: `Morning service → Evening service` (Figma 5:83): what the requester gives, then what they receive. */
export function swapLabel(swap: Pick<Swap, 'offered' | 'requested'>): string {
  return `${swap.offered.title} → ${swap.requested.title}`;
}

/** `Amara ↔ Daniel · Thu 15 Oct` (Figma 5:84): first names, and the day of the shift the requester gives. */
export function swapDetail(swap: Pick<Swap, 'requester' | 'counterparty' | 'offered'>, timeZone: string): string {
  return `${firstName(swap.requester.name)} ↔ ${firstName(swap.counterparty.name)} · ${formatShortDate(dayKeyOf(new Date(swap.offered.startsAt), timeZone))}`;
}

/** The review card's second line (Figma 8:376): one day when both shifts are on it, otherwise each shift with its own day. */
export function swapReviewDetail(swap: Pick<Swap, 'offered' | 'requested'>, timeZone: string): string {
  const a = new Date(swap.offered.startsAt);
  const b = new Date(swap.requested.startsAt);
  const times = (s: SwapShift) => `${formatTime(new Date(s.startsAt), timeZone)}–${formatTime(new Date(s.endsAt), timeZone)}`;
  const dayA = dayKeyOf(a, timeZone);
  const dayB = dayKeyOf(b, timeZone);
  if (dayA === dayB) return `${formatShortDate(dayA)}\n${times(swap.offered)} ↔ ${times(swap.requested)}`;
  return `${formatShortDate(dayA)} ${times(swap.offered)}\n↔ ${formatShortDate(dayB)} ${times(swap.requested)}`;
}

/** A shift in a picker's list: `Thu 15 Oct · 09:00 – 17:00 · Morning service`, and for a teammate's shift their name first (`Daniel Mensah · Thu 15 Oct · …`). */
export function shiftOptionLabel(shift: { title: string; startsAt: string; endsAt: string; assignee: { name: string } | null }, timeZone: string, withPerson: boolean): string {
  const base = `${shiftWhen(shift, timeZone)} · ${shift.title}`;
  return withPerson && shift.assignee ? `${shift.assignee.name} · ${base}` : base;
}

/** The title of the card's status word (Pending, Approved, …). */
export const statusWord = (swap: Pick<Swap, 'status'>): string => swapStatusCopy[swap.status];

/** The header of the swap screen for a request in this state, and for this viewer (Figma 8:355, 8:372, 8:386, 8:399). */
export function swapHeader(swap: Pick<Swap, 'status' | 'canDecide'>): { title: string; subtitle: string } {
  switch (swap.status) {
    case 'approved':
      return { title: swapReviewCopy.approved.title, subtitle: swapReviewCopy.approved.subtitle };
    case 'rejected':
      return { title: swapReviewCopy.rejected.title, subtitle: swapReviewCopy.rejected.subtitle };
    case 'cancelled':
      return { title: swapReviewCopy.cancelled.title, subtitle: swapReviewCopy.cancelled.subtitle };
    case 'pending':
      return swap.canDecide ? { title: swapReviewCopy.title, subtitle: swapReviewCopy.subtitle } : { title: swapSentCopy.title, subtitle: swapSentCopy.subtitle };
  }
}
