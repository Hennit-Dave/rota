/**
 * Who may decide a swap (Dave, 2026-10-27): an Owner or Manager, but NOT one who is part of the swap. The one exception: an Owner who is part of it may
 * decide it when there is nobody else who could (no other Owner or Manager on the team), because otherwise it could never be decided. A Manager who is
 * part of a swap never decides it, even if they are the only Manager: the Owner can.
 */
export function approverMayDecide(input: {
  callerId: string;
  callerRole: 'owner' | 'manager' | 'staff';
  requesterId: string;
  counterpartyId: string;
  /** Every Owner and Manager of the team (user IDs), the caller included. */
  approverIds: readonly string[];
}): boolean {
  if (input.callerRole !== 'owner' && input.callerRole !== 'manager') return false;
  const isParty = input.callerId === input.requesterId || input.callerId === input.counterpartyId;
  if (!isParty) return true;
  if (input.callerRole !== 'owner') return false;
  return input.approverIds.every((id) => id === input.callerId);
}
