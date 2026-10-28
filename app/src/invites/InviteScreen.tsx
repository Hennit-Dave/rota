import { useMutation } from '@tanstack/react-query';
import { router, useIsFocused } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useMe } from '../auth/useMe';
import { bannerCopy } from '../auth/copy';
import { meQueryKey, getInviteApi, getSessionActions, queryClient } from '../services';
import { useSessionStore } from '../state/sessionStore';
import type { TeamSummary } from '../teams/teamResponses';
import { ColorsOverrideProvider, lightColors, space, useColors } from '../theme';
import { Button } from '../ui/Button';
import { InfoCard } from '../ui/InfoCard';
import { PageHeader } from '../ui/PageHeader';
import { Screen, Spacer } from '../ui/Screen';
import { StatusBanner } from '../ui/StatusBanner';
import { createLatch } from '../ui/latch';
import { useOnline } from '../ui/useOnline';
import { applyAcceptedTeam } from './acceptedTeam';
import { inviteAuthParams } from './inviteAuthParams';
import { inviteCopy, roleAccess, roleLabel } from './inviteCopy';
import { goBackTo } from './goBackTo';
import { describeInviteFailure, type InviteFailure } from './inviteFailure';
import type { AuthUser } from '../auth/authResponses';
import type { PendingInvitePreview } from './inviteResponses';
import { inviteView, type PreviewState } from './inviteScreenState';
import { useInvitePreview } from './useInvitePreview';

/**
 * The screen a link opens (`rota://invite/<token>`, `https://rota.davebuilds.design/invite/<token>`). It lives outside both session
 * guards, so it can be reached signed in or signed out, and it is the one place the whole flow happens: Sign in and Create account
 * open on top of it carrying the token, and when the session starts they send the person back to it (ADR 0017). Nothing is stored: the
 * token stays in the route.
 * Opening the link only calls preview, which consumes nothing; the invitation is accepted only by the tap on "Accept invitation".
 * Light only, like the auth screens, until the theme is a per-user server setting (issue #24).
 */
export function InviteScreen({ token }: { token: string | null }) {
  return (
    <ColorsOverrideProvider colors={lightColors}>
      <InviteBody token={token} />
    </ColorsOverrideProvider>
  );
}

/** Every way out of this screen (Accept, Back to Rota, Back to login, Close, the already-member redirect) goes through here (goBackTo). */
const leave = (signedIn: boolean) => goBackTo(router, signedIn ? '/' : '/login');

function InviteBody({ token }: { token: string | null }) {
  const colors = useColors();
  const session = useSessionStore((s) => s.status);
  const focused = useIsFocused();
  const preview = useInvitePreview(token, session, focused);
  const [acceptFailure, setAcceptFailure] = useState<InviteFailure | null>(null);
  // Accept is disabled from the FIRST tap until the request finishes (Figma note 232:415). The button only greys out after React renders again, and
  // two quick taps can both arrive before that, so the handler asks a synchronous latch first.
  const [acceptLatch] = useState(createLatch);

  const accept = useMutation({
    // Never queued offline and never retried (app-state.md): a tap that cannot reach the server fails at once and can be tapped again.
    networkMode: 'always',
    retry: 0,
    mutationFn: () => getInviteApi().accept(token as string),
    onMutate: () => setAcceptFailure(null),
    onSuccess: (team) => {
      applyAcceptedTeam(
        { queryClient, userId: queryClient.getQueryData<AuthUser>(meQueryKey)?.id, selectTeam: (id) => useSessionStore.getState().selectTeam(id) },
        team,
      );
      leave(true);
    },
    onError: (error) => setAcceptFailure(describeInviteFailure(error)),
    onSettled: () => acceptLatch.release(),
  });

  const previewState: PreviewState = preview.isError
    ? { status: 'error', error: preview.error }
    : preview.data
      ? { status: 'success', data: preview.data }
      : { status: 'pending' };
  const view = inviteView({ session, token, preview: previewState, acceptFailure });
  const signedIn = session === 'signedIn';

  switch (view.kind) {
    case 'blank':
      return <View style={{ flex: 1, backgroundColor: colors.background }} />;
    case 'loading':
      return (
        <Screen gap={space[16]}>
          <PageHeader eyebrowGap={16} title={inviteCopy.loading.title} subtitle={inviteCopy.loading.subtitle} />
        </Screen>
      );
    case 'signed_out':
      return <SignedOutView preview={view.preview} token={token as string} />;
    case 'confirm':
      return (
        <ConfirmView
          preview={view.preview}
          accepting={accept.isPending}
          failure={acceptFailure}
          onAccept={() => {
            if (acceptLatch.tryAcquire()) accept.mutate();
          }}
        />
      );
    case 'wrong_account':
      return <WrongAccountView />;
    case 'already_member':
      return <AlreadyMemberView team={view.team} focused={focused} />;
    case 'unavailable':
      return <UnavailableView signedIn={signedIn} />;
    case 'problem':
      return <ProblemView failure={view.failure} signedIn={signedIn} retrying={preview.isFetching} onRetry={() => void preview.refetch()} />;
  }
}

/** invite-accept (8:119): not signed in. Sign in and Create account open on top of this screen and carry the invited address. */
function SignedOutView({ preview, token }: { preview: PendingInvitePreview; token: string }) {
  const copy = inviteCopy.signedOut;
  const role = roleLabel[preview.role];
  const params = inviteAuthParams({ token, email: preview.email ?? '' });
  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} teamName={preview.team.name} title={copy.title} subtitle={copy.subtitle(preview.team.name, role)} />
      <StatusBanner
        tone="info"
        title={copy.from(preview.inviter.name, preview.inviter.role ? roleLabel[preview.inviter.role] : null)}
        body={preview.email === null ? copy.bodyLink : copy.body(preview.email)}
      />
      <InfoCard title={preview.team.name} body={copy.yourRole(role)} />
      <Spacer />
      <Button label={copy.signIn} onPress={() => router.push({ pathname: '/login', params })} testID="invite-sign-in" />
      <Button label={copy.createAccount} variant="secondary" onPress={() => router.push({ pathname: '/signup', params })} testID="invite-create-account" />
    </Screen>
  );
}

/** invite-confirm (8:134): signed in as the invited account (or the server could not tell). Accepting is the explicit tap. */
function ConfirmView(props: { preview: PendingInvitePreview; accepting: boolean; failure: InviteFailure | null; onAccept: () => void }) {
  const { preview, accepting, failure, onAccept } = props;
  const online = useOnline();
  const me = useMe();
  const copy = inviteCopy.confirm;
  const access = roleAccess[preview.role];

  let banner: React.ReactNode = null;
  if (!online) {
    banner = <StatusBanner tone="warning" title={bannerCopy.offline} />;
  } else if (failure?.kind === 'rate_limited' || failure?.kind === 'offline') {
    banner = <StatusBanner tone="warning" title={failure.message} />;
  } else if (failure?.kind === 'generic') {
    banner = (
      <StatusBanner tone="error" title={failure.message} reference={failure.reference ? `${bannerCopy.referencePrefix}${failure.reference}` : undefined} />
    );
  }

  return (
    <Screen gap={space[16]}>
      <PageHeader
        eyebrowGap={16}
        teamName={preview.team.name}
        title={copy.title(preview.team.name, roleLabel[preview.role])}
        subtitle={me.data ? copy.subtitle(me.data.name) : undefined}
      />
      <InfoCard title={access.title} body={access.body} />
      {banner}
      <Spacer />
      <Button
        label={copy.accept}
        loading={accepting}
        loadingLabel={copy.accepting}
        disabled={!online}
        onPress={onAccept}
        testID="invite-accept"
      />
    </Screen>
  );
}

/** invite-wrong-email (100:204): a different account is signed in. Nothing was granted. Logging out brings back the signed-out invitation. */
function WrongAccountView() {
  const copy = inviteCopy.wrongAccount;
  const [busy, setBusy] = useState(false);
  async function logOut() {
    if (busy) return;
    setBusy(true);
    try {
      await getSessionActions().logout(); // the store resets; this screen stays and shows the signed-out invitation
    } finally {
      setBusy(false);
    }
  }
  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={copy.title} subtitle={copy.subtitle} />
      <StatusBanner tone="warning" title={copy.bannerTitle} body={copy.bannerBody} />
      <Spacer />
      <Button label={copy.logOut} loading={busy} loadingLabel={copy.loggingOut} onPress={() => void logOut()} testID="invite-log-out" />
      <Button label={copy.back} variant="secondary" disabled={busy} onPress={() => leave(true)} testID="invite-back" />
    </Screen>
  );
}

/** invite-expired (8:146): one answer for expired, used, revoked, unknown and malformed links. */
function UnavailableView({ signedIn }: { signedIn: boolean }) {
  const copy = inviteCopy.unavailable;
  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={copy.title} subtitle={copy.subtitle} />
      <StatusBanner tone="warning" title={copy.bannerTitle} body={copy.bannerBody} />
      <Spacer />
      <Button label={signedIn ? copy.backToRota : copy.backToLogin} onPress={() => leave(signedIn)} testID="invite-unavailable-back" />
    </Screen>
  );
}

/** invite-offline (289:469), and the same layout for a rate limit or an unexpected error (no frames: login patterns). */
function ProblemView(props: {
  failure: Extract<InviteFailure, { kind: 'offline' | 'rate_limited' | 'generic' }>;
  signedIn: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { failure, signedIn, retrying, onRetry } = props;
  const offline = failure.kind === 'offline';
  const copy = offline ? inviteCopy.offline : inviteCopy.problem;
  let banner: React.ReactNode;
  if (offline) {
    banner = <StatusBanner tone="warning" title={inviteCopy.offline.bannerTitle} body={inviteCopy.offline.bannerBody} />;
  } else if (failure.kind === 'rate_limited') {
    banner = <StatusBanner tone="warning" title={failure.message} />;
  } else {
    banner = (
      <StatusBanner tone="error" title={failure.message} reference={failure.reference ? `${bannerCopy.referencePrefix}${failure.reference}` : undefined} />
    );
  }
  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={copy.title} subtitle={copy.subtitle} />
      {banner}
      <Spacer />
      <Button label={copy.retry} loading={retrying} loadingLabel={copy.retry} onPress={onRetry} testID="invite-retry" />
      <Button label={copy.close} variant="secondary" disabled={retrying} onPress={() => leave(signedIn)} testID="invite-close" />
    </Screen>
  );
}

/** The caller already accepted this link (preview answered already_member): go to that team, never "no team access was granted". */
function AlreadyMemberView({ team, focused }: { team: TeamSummary; focused: boolean }) {
  const done = useRef(false);
  useEffect(() => {
    // Only the screen in front may navigate: a replace lands on whichever screen is focused, so a copy left underneath once replaced a newer
    // invitation with Home (ADR 0017).
    if (!focused || done.current) return;
    done.current = true;
    applyAcceptedTeam(
      { queryClient, userId: queryClient.getQueryData<AuthUser>(meQueryKey)?.id, selectTeam: (id) => useSessionStore.getState().selectTeam(id) },
      team,
    );
    leave(true);
  }, [team, focused]);
  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={inviteCopy.alreadyMember.title} subtitle={inviteCopy.alreadyMember.subtitle} />
    </Screen>
  );
}
