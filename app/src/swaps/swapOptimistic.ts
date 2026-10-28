import type { Shift } from '../shifts/shiftResponses';
import type { Swap } from './swapResponses';

/**
 * The guess shown the moment "Send swap request" is tapped (app-state.md: optimistic update). It is what the server will most likely answer, built from
 * the two shifts on screen, and it is ALWAYS replaced by the server's own answer (or removed on failure): the app never treats it as final.
 * `canCancel` and `canDecide` are false: the guess grants no action, only the server's answer does.
 */
export function optimisticSwap(input: { key: string; me: { id: string; name: string }; offered: Shift; requested: Shift; now: Date }): Swap | null {
  const { offered, requested } = input;
  if (!requested.assignee) return null; // the other side must be a teammate's assigned shift; the server refuses anything else
  const side = (s: Shift) => ({ shiftId: s.id, title: s.title, area: s.area, startsAt: s.startsAt, endsAt: s.endsAt });
  return {
    id: optimisticSwapId(input.key),
    status: 'pending',
    createdAt: input.now.toISOString(),
    decidedAt: null,
    requester: input.me,
    counterparty: requested.assignee,
    offered: side(offered),
    requested: side(requested),
    mine: true,
    canCancel: false,
    canDecide: false,
  };
}

export const optimisticSwapId = (key: string) => `optimistic-${key}`;

/** The list with the guess on top (newest first, as the server orders it). */
export const withOptimisticSwap = (list: readonly Swap[] | undefined, swap: Swap): Swap[] => [swap, ...(list ?? []).filter((s) => s.id !== swap.id)];

/** The guess replaced by what the server answered; if the guess is gone (a refetch already replaced it), the answer joins the list. */
export function replaceSwap(list: readonly Swap[] | undefined, id: string, answer: Swap): Swap[] {
  const rest = (list ?? []).filter((s) => s.id !== id && s.id !== answer.id);
  return [answer, ...rest];
}

/** One request answered by the server (cancelled, approved, rejected) put into the list where it was. */
export function updateSwap(list: readonly Swap[] | undefined, answer: Swap): Swap[] | undefined {
  if (!list) return undefined;
  return list.map((s) => (s.id === answer.id ? answer : s));
}

/**
 * Whether a swap request may be started now. Offline it never is (Figma 103:372: "Swaps need a connection and aren't saved for later"): the request is
 * not sent, not queued and not resumed later (app-state.md tests 12 and 14). While one is on its way the control is off (a double tap sends nothing).
 */
export function maySendSwap(state: { online: boolean; sending: boolean }): 'yes' | 'offline' | 'busy' {
  if (state.sending) return 'busy';
  return state.online ? 'yes' : 'offline';
}

/** The order of the list: waiting requests first (those the viewer may decide on top), then the finished ones, each newest first. */
export function orderSwaps(list: readonly Swap[]): Swap[] {
  const rank = (s: Swap) => (s.status === 'pending' ? (s.canDecide ? 0 : 1) : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1));
}
