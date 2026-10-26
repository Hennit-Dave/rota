import type { SessionStatus } from '../state/sessionStore';

/**
 * The settings of the preview query, kept apart from the hook so they can be tested without a device.
 *
 * - `networkMode: 'always'`: TanStack's default PAUSES a query while the device is offline, so it would never start and the screen would show
 *   "Opening your invitation" for ever. With 'always' it runs, the API client sees there is no connection and throws OfflineError at once, and
 *   the screen shows the offline state (Figma 289:469). A request that does start is bounded by the client's own timeout (15 s).
 * - `enabled` needs a token, a verified session, and a focused screen: an invitation screen left underneath others must not keep checking
 *   its link in the background (it once sent the person away from a newer one, ADR 0017).
 * - Nothing is kept: `gcTime 0`, and the secret is not in the key (useInvitePreview).
 */
export function invitePreviewOptions(input: { token: string | null; session: SessionStatus; focused: boolean }) {
  return {
    enabled: input.token !== null && input.session !== 'restoring' && input.focused,
    networkMode: 'always' as const,
    gcTime: 0,
    staleTime: 0,
  };
}
