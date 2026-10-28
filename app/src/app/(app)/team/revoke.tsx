import { useMutation } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useMe } from '../../../auth/useMe';
import { describeInvitationActionFailure, type InvitationActionFailure } from '../../../invites/invitationActionFailure';
import { invitationsCopy } from '../../../invites/invitationsCopy';
import { createInviteApi } from '../../../invites/inviteApi';
import { invitationsQueryKey, useInvitations } from '../../../invites/useInvitations';
import { getApi, queryClient } from '../../../services';
import { useSessionStore } from '../../../state/sessionStore';
import { useTeamDetail } from '../../../teams/useTeamData';
import { space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { InfoCard } from '../../../ui/InfoCard';
import { createLatch } from '../../../ui/latch';
import { PageHeader } from '../../../ui/PageHeader';
import { Screen, Spacer } from '../../../ui/Screen';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';
import { useOnline } from '../../../ui/useOnline';

/**
 * Revoke invitation (Figma 292:988): asks first, because it cannot be undone (the person is told the link is no longer available, and you send a new
 * invitation to bring them back). The route carries only the invitation's ID; the address is read from the list the server sent, so a stale or
 * unknown ID shows "no longer pending" instead of a guess.
 */
export default function RevokeScreen() {
  return <Revoke />;
}

function Revoke() {
  const online = useOnline();
  const { invitationId } = useLocalSearchParams<{ invitationId?: string }>();
  const me = useMe();
  const userId = me.data?.id;
  const teamId = useSessionStore((s) => s.selectedTeamId);
  const detail = useTeamDetail(userId, teamId);
  const invitations = useInvitations(userId, teamId, detail.data?.canManageInvitations === true);
  const [problem, setProblem] = useState<InvitationActionFailure | null>(null);
  const [latch] = useState(createLatch);
  const invitation = invitations.data?.find((item) => item.id === invitationId);
  const copy = invitationsCopy.revokeConfirm;

  const refreshList = () => {
    if (userId && teamId) void queryClient.invalidateQueries({ queryKey: invitationsQueryKey(userId, teamId) });
  };

  const revoke = useMutation({
    networkMode: 'always', // never queued offline (app-state.md)
    retry: 0,
    mutationFn: () => createInviteApi(getApi()).revokeInvitation(teamId as string, invitationId as string),
    onMutate: () => setProblem(null),
    onSuccess: () => {
      refreshList();
      router.back();
    },
    onError: (error) => {
      const result = describeInvitationActionFailure(error);
      setProblem(result);
      if (result?.kind === 'gone') refreshList();
    },
    onSettled: () => latch.release(),
  });

  const loading = !invitations.data && !invitations.isError;
  if (!invitation) {
    return (
      <Screen gap={space[16]}>
        <PageHeader teamName={detail.data?.team.name} title={invitationsCopy.title} subtitle={invitationsCopy.subtitle} />
        {loading ? (
          <Text variant="caption" tone="muted">
            {copy.loading}
          </Text>
        ) : (
          <StatusBanner tone="warning" title={invitations.isError ? invitationsCopy.couldNotLoadTitle : invitationsCopy.gone} />
        )}
        <Spacer />
        <Button label={copy.back} onPress={() => router.back()} testID="revoke-missing-back" />
      </Screen>
    );
  }

  let banner: React.ReactNode = null;
  if (problem?.kind === 'generic') {
    banner = <StatusBanner tone="error" title={invitationsCopy.revokeFailedTitle} body={invitationsCopy.revokeFailedBody} />;
  } else if (problem) {
    banner = <StatusBanner tone="warning" title={problem.message} />;
  }

  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} teamName={detail.data?.team.name} title={copy.title(invitation.email)} subtitle={copy.subtitle} />
      <InfoCard title={copy.cardTitle} body={copy.cardBody} />
      {banner}
      <Spacer />
      <Button
        label={copy.revoke}
        variant="danger"
        loading={revoke.isPending}
        loadingLabel={copy.revoking}
        disabled={!online || !invitation.canRevoke}
        onPress={() => {
          if (latch.tryAcquire()) revoke.mutate();
        }}
        testID="revoke-confirm"
      />
      <Button label={copy.keep} variant="secondary" disabled={revoke.isPending} onPress={() => router.back()} testID="revoke-keep" />
    </Screen>
  );
}
