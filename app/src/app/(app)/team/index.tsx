import { router } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { ApiError, OfflineError } from '../../../api/errors';
import { bannerCopy } from '../../../auth/copy';
import { useMe } from '../../../auth/useMe';
import { roleLabel } from '../../../invites/inviteCopy';
import { directoryInvitationCaption, invitationsCopy } from '../../../invites/invitationsCopy';
import { useInvitations } from '../../../invites/useInvitations';
import { useSessionStore } from '../../../state/sessionStore';
import { canInvite, directoryStatus, showEmptyTeamCard } from '../../../teams/directory';
import { teamCopy } from '../../../teams/teamCopy';
import { useMembers, useTeamDetail } from '../../../teams/useTeamData';
import { useTeams } from '../../../teams/useTeams';
import { ColorsOverrideProvider, lightColors, space } from '../../../theme';
import { AppNav } from '../../../ui/AppNav';
import { Button } from '../../../ui/Button';
import { EmptyCard } from '../../../ui/EmptyCard';
import { PageHeader } from '../../../ui/PageHeader';
import { PersonCard } from '../../../ui/PersonCard';
import { Screen, Spacer } from '../../../ui/Screen';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';
import { TextAction } from '../../../ui/TextAction';
import { useOnline } from '../../../ui/useOnline';

/**
 * Team directory (Figma 8:181, and 103:2521 when you are the only member): who is on the team, and the way to invite someone. Light-only for now,
 * like the other screens whose Figma icons carry their colour (issue #24). The bottom bar is the way out to Schedule and Settings. The list is the whole roster (the server returns it in one
 * answer), so it has loading, empty and error states but no pages and no end-of-list marker.
 */
export default function TeamScreen() {
  return (
    <ColorsOverrideProvider colors={lightColors}>
      <TeamDirectory />
    </ColorsOverrideProvider>
  );
}

function TeamDirectory() {
  const online = useOnline();
  const me = useMe();
  const userId = me.data?.id;
  const teamId = useSessionStore((s) => s.selectedTeamId);
  const teams = useTeams(userId);
  const detail = useTeamDetail(userId, teamId);
  const members = useMembers(userId, teamId);
  // Only Owners and Managers may list invitations (the server says so); a failure here never blocks the roster, the pending screen has its own error state.
  const invitations = useInvitations(userId, teamId, detail.data?.canManageInvitations === true);

  const teamName = detail.data?.team.name ?? teams.data?.find((t) => t.id === teamId)?.name;
  const status = directoryStatus({
    teamId,
    teams: { isError: teams.isError, count: teams.data?.length },
    meFailed: me.isError,
    hasMembers: members.data !== undefined,
    membersFailed: members.isError,
    detailFailed: detail.isError,
  });
  const failed = status === 'failed';
  const failure = (members.error ?? detail.error ?? teams.error ?? me.error) as unknown;

  // Someone with no team at all has nothing to show here: Home sends them on to Create team.
  useEffect(() => {
    if (status === 'no_team') router.replace('/');
  }, [status]);

  let content: React.ReactNode;
  if (members.data) {
    content = (
      <>
        {members.data.map((member) => (
          <PersonCard key={member.userId} title={member.name} caption={roleLabel[member.role]} testID={`member-${member.userId}`} />
        ))}
        {showEmptyTeamCard(members.data, userId) ? <EmptyCard title={teamCopy.emptyTitle} body={teamCopy.emptyBody} testID="team-empty" /> : null}
        {invitations.data && invitations.data.length > 0 ? (
          <View style={{ gap: space[8] }}>
            <Text variant="label">{invitationsCopy.directory.heading}</Text>
            {/* A preview of the oldest pending invitation, as in the design; "Manage invitations" has the whole list. */}
            <PersonCard
              title={invitations.data[0]!.email}
              caption={directoryInvitationCaption(invitations.data[0]!).text}
              captionTone={directoryInvitationCaption(invitations.data[0]!).tone}
              testID="team-invitation-preview"
            />
            <TextAction label={invitationsCopy.directory.manage} onPress={() => router.push('/team/invitations')} testID="team-manage-invitations" />
          </View>
        ) : null}
      </>
    );
  } else if (failed) {
    const offline = failure instanceof OfflineError || !online;
    const reference = failure instanceof ApiError && failure.requestId ? `${bannerCopy.referencePrefix}${failure.requestId}` : undefined;
    content = (
      <>
        {offline ? (
          <StatusBanner tone="warning" title={teamCopy.offlineTitle} body={teamCopy.offlineBody} />
        ) : (
          <StatusBanner tone="error" title={teamCopy.couldNotLoad} reference={reference} />
        )}
        <Button
          label={teamCopy.retry}
          variant="secondary"
          onPress={() => {
            // With no team selected the roster queries are off: who the person is, then the team list, have to be asked again (the list then selects a team).
            void me.refetch();
            void teams.refetch();
            if (teamId !== null) {
              void members.refetch();
              void detail.refetch();
            }
          }}
          testID="team-retry"
        />
      </>
    );
  } else {
    content = (
      <Text variant="caption" tone="muted">
        {teamCopy.loading}
      </Text>
    );
  }

  return (
    <Screen gap={space[12]}>
      <PageHeader
        teamName={teamName}
        title={teamCopy.title}
        subtitle={members.data && teamName ? teamCopy.subtitle(teamName, members.data.length) : undefined}
      />
      {content}
      {canInvite(detail.data) ? <Button label={teamCopy.invite} variant="outline" onPress={() => router.push('/team/invite')} testID="team-invite" /> : null}
      <Spacer />
      <AppNav selected="team" />
    </Screen>
  );
}
