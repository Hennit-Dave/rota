import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { describeAuthFailure } from '../auth/authFailure';
import { recoveryCopy } from '../auth/copy';
import { goBackTo } from '../invites/goBackTo';
import { getAuthActions, getSessionActions } from '../services';
import { useSessionStore } from '../state/sessionStore';
import { space } from '../theme';
import { Button } from '../ui/Button';
import { createLatch } from '../ui/latch';
import { PageHeader } from '../ui/PageHeader';
import { Screen, Spacer } from '../ui/Screen';
import { StatusBanner } from '../ui/StatusBanner';
import { useOnline } from '../ui/useOnline';
import { FailureBanner, toShown } from './FailureBanner';
import { LinkUnavailableView } from './LinkUnavailableView';

/**
 * The magic link's screen (Figma magic-confirm 8:61). Opening the link only shows this screen: it calls nothing. Only the button's POST redeems
 * the link, so an email scanner or a stray tap on a preview consumes nothing (security.md). If someone is already signed in, they are logged out
 * because the link starts a different session, but only AFTER the server accepted the link, so a dead link never costs them their session.
 * The token stays in memory in the route; it is never stored, logged or put in a query key.
 */
export function MagicConfirmScreen({ token }: { token: string | null }) {
  const copy = recoveryCopy.confirm;
  const online = useOnline();
  const session = useSessionStore((s) => s.status);
  const latch = useRef(createLatch()).current;
  const [submitting, setSubmitting] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof toShown>>(null);

  if (!token || unavailable) return <LinkUnavailableView kind="magic" signedIn={session === 'signedIn'} />;

  async function submit() {
    if (!token || !latch.tryAcquire()) return;
    setSubmitting(true);
    setFailure(null);
    try {
      // Someone already signed in is logged out only once the server has accepted the link: a dead link must not end their session.
      await getAuthActions().redeemMagicLink(token, {
        replacingSession: session === 'signedIn' ? async () => void (await getSessionActions().logout()) : undefined,
      });
      // The session started: Home now exists. Leave without leaving this screen behind (ADR 0017).
      goBackTo(router, '/');
    } catch (error) {
      const result = describeAuthFailure('reset', error);
      if (!result) return; // a result for a previous account: show nothing
      if (result.kind === 'link_unavailable') setUnavailable(true);
      else setFailure(toShown(result));
    } finally {
      latch.release();
      setSubmitting(false);
    }
  }

  return (
    <Screen gap={space[24]}>
      <PageHeader title={copy.title} subtitle={copy.subtitle} />
      <StatusBanner tone="info" title={copy.bannerTitle} body={copy.bannerBody} />
      <FailureBanner failure={failure} online={online} />
      <Spacer />
      <Button
        label={copy.submit}
        loading={submitting}
        loadingLabel={copy.submitting}
        disabled={!online}
        onPress={() => void submit()}
        testID="magic-confirm-submit"
      />
    </Screen>
  );
}
