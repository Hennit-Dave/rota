export type PendingListStatus = 'loading' | 'failed' | 'not_allowed' | 'empty' | 'ready';

/**
 * What the pending-invitations screen shows. It needs two answers: what the person may do here (only Owners and Managers may list invitations;
 * the server says so) and the list itself. A list already on screen stays on screen if a later refresh fails. Every case ends, none waits for ever.
 */
export function pendingListStatus(input: {
  detail: { loaded: boolean; failed: boolean; canManageInvitations: boolean };
  list: { loaded: boolean; failed: boolean; count: number };
}): PendingListStatus {
  if (input.list.loaded) return input.list.count === 0 ? 'empty' : 'ready';
  if (input.detail.failed) return 'failed';
  if (input.detail.loaded && !input.detail.canManageInvitations) return 'not_allowed';
  if (input.list.failed) return 'failed';
  return 'loading';
}
