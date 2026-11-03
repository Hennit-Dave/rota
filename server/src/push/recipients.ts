/**
 * Who is told about a shift or swap event (ADR 0033; Dave, 2026-11-03). Pure: the services read the people (the shift's assignee, the swap's two parties, the
 * approvers) inside the event's own transaction and ask these functions who to tell. **Never the person who acted.** The push job still re-checks, when it runs,
 * that each recipient is an active member of the team and has the type switched on.
 */
const unique = (ids: Array<string | null | undefined>, except: string[]): string[] => {
  const out: string[] = [];
  for (const id of ids) if (id && !except.includes(id) && !out.includes(id)) out.push(id);
  return out;
};

/**
 * A shift was created, changed or deleted: the person it is assigned to is told, and so is the person it was taken from (an update that changed the assignee).
 * An open shift (nobody assigned) tells nobody.
 */
export function shiftEventRecipients(input: { actorUserId: string; assignedUserId: string | null; previousAssignedUserId?: string | null }): string[] {
  return unique([input.assignedUserId, input.previousAssignedUserId], [input.actorUserId]);
}

/**
 * A swap was requested. The people who can decide it are told it needs them (the Owner and Managers, never the requester or the other party: a party to the swap
 * may not decide it), and the other party is told someone asked to swap with them. Two groups because the words differ.
 */
export function swapRequestedRecipients(input: { actorUserId: string; counterpartyUserId: string; approverIds: string[] }): { approvers: string[]; counterparty: string[] } {
  return {
    approvers: unique(input.approverIds, [input.actorUserId, input.counterpartyUserId]),
    counterparty: unique([input.counterpartyUserId], [input.actorUserId]),
  };
}

/** A swap was approved or rejected: both people in it are told, never the person who decided (a manager, or the other party if they decided it). */
export function swapDecidedRecipients(input: { actorUserId: string; requesterUserId: string; counterpartyUserId: string }): string[] {
  return unique([input.requesterUserId, input.counterpartyUserId], [input.actorUserId]);
}
