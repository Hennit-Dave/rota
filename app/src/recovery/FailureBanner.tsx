import type { AuthFailure } from '../auth/authFailure';
import { bannerCopy, recoveryCopy } from '../auth/copy';
import { StatusBanner } from '../ui/StatusBanner';

type Shown = Exclude<AuthFailure, { kind: 'fields' } | { kind: 'link_unavailable' } | { kind: 'credentials' } | { kind: 'email_in_use' }>;

/**
 * The banner every reset and magic-link screen shows for a failed call, in the login patterns (229:3485 rate limited, 229:3586 generic).
 * No frame of its own for these screens. A connection that is down right now shows the offline banner first.
 */
export function FailureBanner({ failure, online }: { failure: Shown | null; online: boolean }) {
  if (!online) return <StatusBanner tone="warning" title={recoveryCopy.offline} />;
  if (!failure) return null;
  if (failure.kind === 'rate_limited' || failure.kind === 'offline') return <StatusBanner tone="warning" title={failure.message} />;
  return (
    <StatusBanner
      tone="error"
      title={failure.message}
      reference={failure.reference ? `${bannerCopy.referencePrefix}${failure.reference}` : undefined}
    />
  );
}

/** A failure the screen has no special layout for: link_unavailable and the login-only kinds are generic here. */
export function toShown(failure: AuthFailure): Shown | null {
  if (failure.kind === 'fields') return null;
  if (failure.kind === 'rate_limited' || failure.kind === 'offline' || failure.kind === 'generic') return failure;
  return { kind: 'generic', message: bannerCopy.generic, reference: null };
}
