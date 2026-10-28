import { ApiError } from '../api/errors';

export type SwapStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** The shift on one side of a swap, as it looked when the swap was requested. */
export interface SwapShift {
  shiftId: string;
  title: string;
  area: string | null;
  startsAt: string;
  endsAt: string;
}

/**
 * One swap request as the server describes it (docs/ARCHITECTURE.md 5f). `canCancel` and `canDecide` are the SERVER'S answer to "may this person do that
 * now": the app shows buttons accordingly and decides nothing (AGENTS.md rule 3); the server checks again on the action.
 */
export interface Swap {
  id: string;
  status: SwapStatus;
  createdAt: string;
  decidedAt: string | null;
  requester: { id: string; name: string };
  counterparty: { id: string; name: string };
  offered: SwapShift;
  requested: SwapShift;
  mine: boolean;
  canCancel: boolean;
  canDecide: boolean;
}

const unreadable = () => new ApiError(200, 'invalid_response', 'The server answer could not be read.', null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const STATUSES: readonly string[] = ['pending', 'approved', 'rejected', 'cancelled'];

function parsePerson(v: unknown): { id: string; name: string } | null {
  return isRecord(v) && typeof v.id === 'string' && typeof v.name === 'string' ? { id: v.id, name: v.name } : null;
}

function parseShift(v: unknown): SwapShift | null {
  if (!isRecord(v)) return null;
  const { shiftId, title, area, startsAt, endsAt } = v;
  if (typeof shiftId !== 'string' || typeof title !== 'string' || typeof startsAt !== 'string' || typeof endsAt !== 'string') return null;
  if (area !== null && typeof area !== 'string') return null;
  if (Number.isNaN(Date.parse(startsAt)) || Number.isNaN(Date.parse(endsAt))) return null;
  return { shiftId, title, area, startsAt, endsAt };
}

export function parseSwap(value: unknown): Swap | null {
  if (!isRecord(value)) return null;
  const { id, status, createdAt, decidedAt, mine, canCancel, canDecide } = value;
  const requester = parsePerson(value.requester);
  const counterparty = parsePerson(value.counterparty);
  const offered = parseShift(value.offered);
  const requested = parseShift(value.requested);
  if (typeof id !== 'string' || typeof status !== 'string' || !STATUSES.includes(status) || typeof createdAt !== 'string') return null;
  if (decidedAt !== null && typeof decidedAt !== 'string') return null;
  if (typeof mine !== 'boolean' || typeof canCancel !== 'boolean' || typeof canDecide !== 'boolean') return null;
  if (!requester || !counterparty || !offered || !requested) return null;
  return { id, status: status as SwapStatus, createdAt, decidedAt, requester, counterparty, offered, requested, mine, canCancel, canDecide };
}

/** `{ swaps: [...] }`. Throws if any part cannot be read: half a list is worse than an error. */
export function parseSwapList(body: unknown): Swap[] {
  if (!isRecord(body) || !Array.isArray(body.swaps)) throw unreadable();
  return body.swaps.map((raw) => {
    const swap = parseSwap(raw);
    if (!swap) throw unreadable();
    return swap;
  });
}

/** `{ swap }` as create, cancel, approve, reject and get answer. */
export function parseSwapResponse(body: unknown): Swap {
  const swap = isRecord(body) ? parseSwap(body.swap) : null;
  if (!swap) throw unreadable();
  return swap;
}

/** Personal and team data: the key carries the user ID and the team ID (app-state.md), so sign-out clears it and another account can never read it. */
export const swapsKey = (userId: string, teamId: string) => ['swaps', userId, teamId] as const;
