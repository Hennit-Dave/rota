import { z } from 'zod';

/**
 * What a push says and where tapping it goes (ADR 0032). The TEXT is frozen on the `push_event` work row when the event happens (like an email's body: a retry
 * sends exactly that). The `data` the phone receives carries only a version, a type, a moment and ids, never a path and never an amount: the app maps a known
 * type to a screen and ignores anything else, and the screen loads its data through the normal authorised API. So a forged notification opens a screen and
 * shows nothing the user could not already see (AGENTS.md rules 2 and 3).
 */

/** The three notification types the settings screen has (ADR 0024). */
export const PUSH_TYPES = ['shift_changes', 'swap_updates', 'billing'] as const;
export type PushType = (typeof PUSH_TYPES)[number];

/**
 * The moments a push can be about. Part 1: the two billing ones. Part 2: the shift and swap ones, one per activity kind (ADR 0033).
 * `renewal_failed` and `renewal_read_only` are ESSENTIAL: they warn the Owner about losing access, so they skip the `notifyBilling` toggle (Dave, 2026-11-03,
 * ADR 0031). Quiet hours still apply to them (Dave, 2026-11-03). The shift and swap moments are NOT essential: the person's switch for that type applies.
 */
export const PUSH_MOMENTS = [
  'renewal_failed',
  'renewal_read_only',
  'shift_created',
  'shift_updated',
  'shift_deleted',
  'swap_requested',
  'swap_approved',
  'swap_rejected',
] as const;
export type PushMoment = (typeof PUSH_MOMENTS)[number];

export const MOMENT_TYPE: Record<PushMoment, PushType> = {
  renewal_failed: 'billing',
  renewal_read_only: 'billing',
  shift_created: 'shift_changes',
  shift_updated: 'shift_changes',
  shift_deleted: 'shift_changes',
  swap_requested: 'swap_updates',
  swap_approved: 'swap_updates',
  swap_rejected: 'swap_updates',
};

/**
 * One Android notification channel per type (Dave, 2026-11-03, ADR 0033), so a person can mute one type in the phone's own settings. The ids are what the server
 * names in each push and what the app creates at every registration. A push that names a channel the installed app has not created is DROPPED SILENTLY (found in
 * step 0): `default` is kept only because part 1 sent everything on it.
 */
export const PUSH_CHANNELS = { shift_changes: 'shift_changes', swap_updates: 'swap_updates', billing: 'billing' } as const satisfies Record<PushType, string>;
export type PushChannelId = (typeof PUSH_CHANNELS)[PushType];
export const channelFor = (type: PushType): PushChannelId => PUSH_CHANNELS[type];

/** Moments that ignore the per-type toggle. */
export const ESSENTIAL_MOMENTS: ReadonlySet<PushMoment> = new Set<PushMoment>(['renewal_failed', 'renewal_read_only']);

const uuid = z.string().regex(/^[0-9a-f-]{36}$/);

/** The work row on the TEAM shard, written in the same transaction as the event (jobs.md: Postgres first). */
export const pushEventPayload = z.strictObject({
  moment: z.enum(PUSH_MOMENTS),
  teamId: uuid,
  /** Recipients chosen when the event happened. The send job re-checks each one's role and settings when it runs. */
  recipients: z.array(uuid).min(1).max(50),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(300),
  /** The renewal this is about, for the check "is it still unpaid". */
  renewalId: uuid.optional(),
  /** Where a tap goes: a shift event opens that shift, a swap event opens that swap (the app maps these ids to a screen; the server never sends a path). */
  shiftId: uuid.optional(),
  swapId: uuid.optional(),
  /** The "read-only" notice is made at the failure but runs at the end of the grace period; if the renewal was paid by then it is wrong, so nothing is sent. */
  skipIfRenewalPaid: z.boolean().optional(),
});
export type PushEventPayload = z.infer<typeof pushEventPayload>;

/** The `push` work row on shard A, one per (event, recipient). */
export const pushPayload = z.strictObject({
  dedupeKey: z.string().min(1).max(100),
  eventRowId: uuid,
  userId: uuid,
  teamId: uuid,
  /** The team's time zone when the row was made: quiet hours fall back to it when the user has none (ADR 0024), and a settings change reschedules from it. */
  teamTimeZone: z.string().min(1),
  moment: z.enum(PUSH_MOMENTS),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(300),
  renewalId: uuid.optional(),
  shiftId: uuid.optional(),
  swapId: uuid.optional(),
  skipIfRenewalPaid: z.boolean().optional(),
});
export type PushPayload = z.infer<typeof pushPayload>;

/** What the phone receives in `data`. Versioned so the app can ignore a shape it does not know. */
export interface PushData {
  v: 1;
  type: PushType;
  moment: PushMoment;
  teamId: string;
  shiftId?: string;
  swapId?: string;
}

export function pushDataFor(payload: Pick<PushPayload, 'moment' | 'teamId' | 'shiftId' | 'swapId'>): PushData {
  return {
    v: 1,
    type: MOMENT_TYPE[payload.moment],
    moment: payload.moment,
    teamId: payload.teamId,
    ...(payload.shiftId ? { shiftId: payload.shiftId } : {}),
    ...(payload.swapId ? { swapId: payload.swapId } : {}),
  };
}

/** The `receipts` work row on shard A: tickets to look up about 15 minutes after the send (Expo's advice). */
export const pushReceiptsPayload = z.strictObject({
  pushRowId: uuid,
});
export type PushReceiptsPayload = z.infer<typeof pushReceiptsPayload>;
