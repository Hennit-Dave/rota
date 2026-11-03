import type { Href } from 'expo-router';

/**
 * What tapping a push opens (ADR 0032, ADR 0033). The server sends only a version, a type, a moment, a team id and (for a shift or a swap) that one id, never a
 * path. The app maps a KNOWN shape to a screen and ignores everything else, so a forged or newer-version notification opens nothing. Whatever screen it opens loads
 * its data through the normal authorised API, so a notification can point the app somewhere but can never show anything the signed-in user could not already see.
 * No amount ever travels in a push.
 */
export const BILLING_MOMENTS = ['renewal_failed', 'renewal_read_only'] as const;
export const SHIFT_MOMENTS = ['shift_created', 'shift_updated', 'shift_deleted'] as const;
export const SWAP_MOMENTS = ['swap_requested', 'swap_approved', 'swap_rejected'] as const;
export const PUSH_MOMENTS = [...BILLING_MOMENTS, ...SHIFT_MOMENTS, ...SWAP_MOMENTS] as const;
export type PushMoment = (typeof PUSH_MOMENTS)[number];

export type PushTarget =
  | { type: 'billing'; moment: (typeof BILLING_MOMENTS)[number]; teamId: string }
  | { type: 'shift_changes'; moment: (typeof SHIFT_MOMENTS)[number]; teamId: string; shiftId: string }
  | { type: 'swap_updates'; moment: (typeof SWAP_MOMENTS)[number]; teamId: string; swapId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isIn = (list: readonly string[], v: unknown): v is string => typeof v === 'string' && list.includes(v);
const uuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null);

/**
 * The notification's `data`, or null if it is not exactly a shape this app knows. Extra keys are ignored; a missing or wrong one, or a moment that does not belong to
 * the type, is a refusal. A shift push needs its shift id, a swap push its swap id.
 */
export function parsePushData(raw: unknown): PushTarget | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (d.v !== 1) return null;
  const teamId = uuid(d.teamId);
  if (!teamId) return null;
  if (d.type === 'billing' && isIn(BILLING_MOMENTS, d.moment)) return { type: 'billing', moment: d.moment as (typeof BILLING_MOMENTS)[number], teamId };
  if (d.type === 'shift_changes' && isIn(SHIFT_MOMENTS, d.moment)) {
    const shiftId = uuid(d.shiftId);
    return shiftId ? { type: 'shift_changes', moment: d.moment as (typeof SHIFT_MOMENTS)[number], teamId, shiftId } : null;
  }
  if (d.type === 'swap_updates' && isIn(SWAP_MOMENTS, d.moment)) {
    const swapId = uuid(d.swapId);
    return swapId ? { type: 'swap_updates', moment: d.moment as (typeof SWAP_MOMENTS)[number], teamId, swapId } : null;
  }
  return null;
}

/**
 * The screen for a target. Billing opens the billing hub. A shift change opens that shift (a deleted shift no longer exists, so it opens the schedule). A swap
 * event opens that swap.
 */
export function routeFor(target: PushTarget): Href {
  switch (target.type) {
    case 'billing':
      return '/billing';
    case 'shift_changes':
      return target.moment === 'shift_deleted' ? '/' : { pathname: '/shift/[shiftId]', params: { shiftId: target.shiftId } };
    case 'swap_updates':
      return { pathname: '/swaps/[swapId]', params: { swapId: target.swapId } };
  }
}
