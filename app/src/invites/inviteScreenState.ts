import type { SessionStatus } from '../state/sessionStore';
import type { TeamSummary } from '../teams/teamResponses';
import { describeInviteFailure, type InviteFailure } from './inviteFailure';
import type { InvitePreview, PendingInvitePreview } from './inviteResponses';

/** Which screen the invite route shows. Decided here from plain inputs, so every case is unit-tested without a device. */
export type InviteView =
  | { kind: 'blank' }
  | { kind: 'loading' }
  | { kind: 'signed_out'; preview: PendingInvitePreview }
  | { kind: 'confirm'; preview: PendingInvitePreview }
  | { kind: 'wrong_account' }
  | { kind: 'already_member'; team: TeamSummary }
  | { kind: 'unavailable' }
  | { kind: 'problem'; failure: Extract<InviteFailure, { kind: 'offline' | 'rate_limited' | 'generic' }> };

export type PreviewState = { status: 'pending' } | { status: 'success'; data: InvitePreview } | { status: 'error'; error: unknown };

function fromFailure(failure: InviteFailure | null): InviteView {
  if (failure === null) return { kind: 'loading' }; // the session changed under the request: the status decides what comes next
  if (failure.kind === 'unavailable') return { kind: 'unavailable' };
  // A 403 here means a signed-in account that is not the invited one (accept) and cannot come from preview; treat it the same.
  if (failure.kind === 'wrong_account') return { kind: 'wrong_account' };
  return { kind: 'problem', failure };
}

export function inviteView(input: {
  session: SessionStatus;
  token: string | null;
  preview: PreviewState;
  /** The failure of the last tap on "Accept invitation", if any. */
  acceptFailure: InviteFailure | null;
}): InviteView {
  const { session, token, preview, acceptFailure } = input;
  // The session is verified with the server before anything is shown, so a cold start never flashes the signed-out screen.
  if (session === 'restoring') return { kind: 'blank' };
  if (token === null) return { kind: 'unavailable' };
  // A failed accept belongs to the signed-in account that tapped it: after a log out it is history.
  if (session === 'signedIn' && acceptFailure && (acceptFailure.kind === 'unavailable' || acceptFailure.kind === 'wrong_account')) return fromFailure(acceptFailure);

  if (preview.status === 'pending') return { kind: 'loading' };
  if (preview.status === 'error') return fromFailure(describeInviteFailure(preview.error));

  const data = preview.data;
  if (data.status === 'already_member') {
    // Only a signed-in caller can be told this, so a signed-out answer of this kind is not believed.
    return session === 'signedIn' ? { kind: 'already_member', team: data.team } : { kind: 'unavailable' };
  }
  if (session === 'signedOut') return { kind: 'signed_out', preview: data };
  // Signed in. 'none' means the server saw no usable session (an expired access token): not known, so accept decides.
  return data.account === 'different' ? { kind: 'wrong_account' } : { kind: 'confirm', preview: data };
}
