import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useMe } from '../../../auth/useMe';
import { describeInvitationActionFailure, type InvitationActionFailure } from '../../../invites/invitationActionFailure';
import { invitationCaption, invitationsCopy } from '../../../invites/invitationsCopy';
import { createInviteApi } from '../../../invites/inviteApi';
import { pendingListStatus } from '../../../invites/pendingList';
import { invitationsQueryKey, useInvitations } from '../../../invites/useInvitations';
import { getApi, queryClient } from '../../../services';
import { useSessionStore } from '../../../state/sessionStore';
import { useTeamDetail } from '../../../teams/useTeamData';
import { ColorsOverrideProvider, lightColors, space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { EmptyCard } from '../../../ui/EmptyCard';
import { createLatch } from '../../../ui/latch';
import { PageHeader } from '../../../ui/PageHeader';
import { PersonCard } from '../../../ui/PersonCard';
import { Screen } from '../../../ui/Screen';
import { SkeletonBlock } from '../../../ui/SkeletonBlock';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';
import { useOnline } from '../../../ui/useOnline';

/**
 * Pending invitations (Figma 292:526; states loading 292:610, empty 292:675, error 292:725, resending 292:804, action error 292:890, email not sent
 * 294:3986). Who may resend or revoke each row is the server's `canResend` and `canRevoke`; this screen decides nothing. While one action runs every
 * action is disabled and the one in progress shows the spinner (Figma note 232:415). "Email not sent" is the server's emailStatus `failed`. Light-only (issue #24).
 */
export default function InvitationsScreen() {
  return (
    <ColorsOverrideProvider colors={lightColors}>
      <Invitations />
    </ColorsOverrideProvider>
  );
}

function Invitations() {
  const online = useOnline();
  const me = useMe();
  const userId = me.data?.id;
  const teamId = useSessionStore((s) => s.selectedTeamId);
  const detail = useTeamDetail(userId, teamId);
  const invitations = useInvitations(userId, teamId, detail.data?.canManageInvitations === true);
  const [problem, setProblem] = useState<InvitationActionFailure | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  // One action at a time, decided synchronously (two quick taps can arrive before React re-renders).
  const [latch] = useState(createLatch);

  const refreshList = () => {
    if (userId && teamId) void queryClient.invalidateQueries({ queryKey: invitationsQueryKey(userId, teamId) });
  };

  const resend = useMutation({
    networkMode: 'always', // never queued offline (app-state.md)
    retry: 0,
    mutationFn: (invitationId: string) => createInviteApi(getApi()).resendInvitation(teamId as string, invitationId),
    onMutate: (invitationId) => {
      setProblem(null);
      setResending(invitationId);
    },
    onSuccess: refreshList,
    onError: (error) => {
      const result = describeInvitationActionFailure(error);
      setProblem(result);
      if (result?.kind === 'gone') refreshList(); // it was accepted, revoked or expired meanwhile: show the list as it is now
    },
    onSettled: () => {
      setResending(null);
      latch.release();
    },
  });

  const status = pendingListStatus({
    detail: { loaded: detail.data !== undefined, failed: detail.isError, canManageInvitations: detail.data?.canManageInvitations ?? false },
    list: { loaded: invitations.data !== undefined, failed: invitations.isError, count: invitations.data?.length ?? 0 },
  });
  const busy = resending !== null;

  let banner: React.ReactNode = null;
  if (problem?.kind === 'generic') {
    banner = <StatusBanner tone="error" title={invitationsCopy.resendFailedTitle} body={invitationsCopy.resendFailedBody} testID="invitations-action-error" />;
  } else if (problem) {
    banner = <StatusBanner tone="warning" title={problem.message} testID="invitations-action-warning" />;
  }

  let content: React.ReactNode;
  if (status === 'ready' && invitations.data) {
    content = (
      <>
        {banner}
        {invitations.data.map((invitation) => {
          const caption = invitationCaption(invitation);
          const mine = resending === invitation.id;
          return (
            <View key={invitation.id} style={{ gap: space[8] }}>
              <PersonCard title={invitation.email} caption={caption.text} captionTone={caption.tone} testID={`invitation-${invitation.id}`} />
              {invitation.canResend || invitation.canRevoke ? (
                <View style={{ flexDirection: 'row', gap: space[8] }}>
                  {invitation.canResend ? (
                    <View style={{ flex: 1 }}>
                      <Button
                        label={invitationsCopy.resend}
                        variant="secondary"
                        loading={mine}
                        loadingLabel={invitationsCopy.resend}
                        disabled={!online || busy}
                        onPress={() => {
                          if (latch.tryAcquire()) resend.mutate(invitation.id);
                        }}
                        testID={`resend-${invitation.id}`}
                      />
                    </View>
                  ) : null}
                  {invitation.canRevoke ? (
                    <View style={{ flex: 1 }}>
                      <Button
                        label={invitationsCopy.revoke}
                        variant="danger"
                        disabled={!online || busy}
                        onPress={() => router.push({ pathname: '/team/revoke', params: { invitationId: invitation.id } })}
                        testID={`revoke-${invitation.id}`}
                      />
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })}
      </>
    );
  } else if (status === 'empty') {
    content = (
      <>
        {banner}
        <EmptyCard title={invitationsCopy.emptyTitle} body={invitationsCopy.emptyBody} testID="invitations-empty" />
        <Button label={invitationsCopy.invite} onPress={() => router.push('/team/invite')} testID="invitations-invite" />
      </>
    );
  } else if (status === 'failed') {
    content = (
      <>
        <StatusBanner tone="error" title={invitationsCopy.couldNotLoadTitle} body={invitationsCopy.couldNotLoadBody} />
        <Button
          label={invitationsCopy.retry}
          variant="secondary"
          onPress={() => {
            void me.refetch();
            void detail.refetch();
            void invitations.refetch();
          }}
          testID="invitations-retry"
        />
      </>
    );
  } else if (status === 'not_allowed') {
    content = <StatusBanner tone="warning" title={invitationsCopy.notAllowed} />;
  } else {
    content = (
      <View style={{ gap: space[8] }}>
        <Text variant="body">{invitationsCopy.loading}</Text>
        <SkeletonBlock />
        <SkeletonBlock />
      </View>
    );
  }

  return (
    <Screen gap={space[12]}>
      <PageHeader teamName={detail.data?.team.name} title={invitationsCopy.title} subtitle={invitationsCopy.subtitle} />
      {content}
    </Screen>
  );
}
