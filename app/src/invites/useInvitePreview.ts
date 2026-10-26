import { useQuery } from '@tanstack/react-query';
import { useId, useRef } from 'react';
import { getInviteApi } from '../services';
import type { SessionStatus } from '../state/sessionStore';
import { invitePreviewOptions } from './invitePreviewOptions';

/** A number that changes whenever the token does, so a new link opened on the same screen is fetched again. */
function useTokenVersion(token: string | null): number {
  const ref = useRef({ token, version: 0 });
  if (ref.current.token !== token) ref.current = { token, version: ref.current.version + 1 };
  return ref.current.version;
}

/**
 * What the link is for (POST /invitations/preview). It consumes nothing, so it is safe to repeat: it refetches when the session
 * changes (signed in, so the server can compare the account) and when the app returns to the foreground.
 *
 * The link's secret is a credential, so it is NOT in the query key: the key is this screen's own ID plus a counter that moves
 * when the token does, and the entry is dropped the moment the screen leaves (gcTime 0). Nothing here is persisted (app-state.md).
 * It runs only while the screen is focused and even when offline: see invitePreviewOptions.
 */
export function useInvitePreview(token: string | null, session: SessionStatus, focused: boolean) {
  const screen = useId();
  const version = useTokenVersion(token);
  return useQuery({
    queryKey: ['invite-preview', screen, version, session === 'signedIn' ? 'signedIn' : 'signedOut'],
    ...invitePreviewOptions({ token, session, focused }),
    queryFn: ({ signal }) => getInviteApi().preview(token as string, { signedIn: session === 'signedIn', signal }),
  });
}
