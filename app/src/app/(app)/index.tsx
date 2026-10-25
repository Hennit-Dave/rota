import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ApiError, OfflineError } from '../../api/errors';
import { bannerCopy, homeCopy } from '../../auth/copy';
import { useMe } from '../../auth/useMe';
import { getSessionActions } from '../../services';
import { useSessionStore } from '../../state/sessionStore';
import { teamCopy } from '../../teams/teamCopy';
import { useTeams } from '../../teams/useTeams';
import { space } from '../../theme';
import { Button } from '../../ui/Button';
import { PageHeader } from '../../ui/PageHeader';
import { Screen, Spacer } from '../../ui/Screen';
import { StatusBanner } from '../../ui/StatusBanner';
import { Text } from '../../ui/Text';
import { TextAction } from '../../ui/TextAction';
import { useOnline } from '../../ui/useOnline';

/**
 * PLACEHOLDER home (with a "Team" button as the way into the team directory until the tab bar exists): "Signed in as <name>", the selected team's name, and both sign-out flows, so they can be proven end to end.
 * The real home and settings come in later slices. The name is server data (GET /auth/me) and so is the team (GET /teams): both
 * seeded early and refetched when the app returns to the foreground. A signed-in user with no team goes to create-team.
 */
export default function HomeScreen() {
  const online = useOnline();
  const [busy, setBusy] = useState<'logout' | 'logoutAll' | null>(null);
  const [logoutAllError, setLogoutAllError] = useState<string | null>(null);

  const me = useMe();
  const teams = useTeams(me.data?.id);
  const selectedTeamId = useSessionStore((s) => s.selectedTeamId);
  const team = teams.data?.find((t) => t.id === selectedTeamId) ?? null;

  // No team yet (a new account, or the server lists none): the next step is to create one.
  const noTeams = teams.data !== undefined && teams.data.length === 0;
  useEffect(() => {
    if (noTeams) router.replace('/create-team');
  }, [noTeams]);

  async function logout() {
    if (busy) return;
    setBusy('logout');
    try {
      await getSessionActions().logout(); // the sign-out resets the store; the signed-out side replaces this screen
    } finally {
      setBusy(null);
    }
  }

  async function logoutAll() {
    if (busy) return;
    setBusy('logoutAll');
    setLogoutAllError(null);
    try {
      await getSessionActions().logoutAll();
    } catch (error) {
      setLogoutAllError(error instanceof OfflineError ? homeCopy.logoutAllOffline : homeCopy.logoutAllFailed);
    } finally {
      setBusy(null);
    }
  }

  let status: React.ReactNode = null;
  if (me.data) {
    status = <Text variant="heading">{homeCopy.signedInAs(me.data.name)}</Text>;
  } else if (!online) {
    status = <StatusBanner tone="warning" title={homeCopy.offlineTitle} body={homeCopy.offlineBody} />;
  } else if (me.isError) {
    const reference = me.error instanceof ApiError && me.error.requestId ? `${bannerCopy.referencePrefix}${me.error.requestId}` : undefined;
    status = (
      <>
        <StatusBanner tone="error" title={homeCopy.couldNotLoad} reference={reference} />
        <Button label={homeCopy.retry} variant="secondary" onPress={() => void me.refetch()} testID="home-retry" />
      </>
    );
  } else {
    status = <Text variant="heading">{homeCopy.signedIn}</Text>;
  }

  let teamStatus: React.ReactNode = null;
  if (team) {
    teamStatus = (
      <Text variant="heading" testID="home-team-name">
        {team.name}
      </Text>
    );
  } else if (teams.isError && online) {
    const reference = teams.error instanceof ApiError && teams.error.requestId ? `${bannerCopy.referencePrefix}${teams.error.requestId}` : undefined;
    teamStatus = (
      <>
        <StatusBanner tone="error" title={homeCopy.teamCouldNotLoad} reference={reference} />
        <Button label={homeCopy.retry} variant="secondary" onPress={() => void teams.refetch()} testID="home-teams-retry" />
      </>
    );
  } else if (me.data && !noTeams && online) {
    teamStatus = (
      <Text variant="caption" tone="muted">
        {homeCopy.teamLoading}
      </Text>
    );
  }

  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} title={homeCopy.title} teamName={team?.name} />
      {status}
      {teamStatus}
      <Text variant="caption" tone="muted">
        {homeCopy.placeholderNote}
      </Text>
      {logoutAllError ? <StatusBanner tone="error" title={logoutAllError} /> : null}
      {team ? <Button label={teamCopy.homeEntry} variant="outline" onPress={() => router.push('/team')} testID="home-team" /> : null}
      <Spacer />
      {__DEV__ ? <TextAction label="API check (development only)" onPress={() => router.push('/dev-api')} /> : null}
      <Button
        label={homeCopy.logout}
        loading={busy === 'logout'}
        loadingLabel={homeCopy.loggingOut}
        disabled={busy === 'logoutAll'}
        onPress={() => void logout()}
        testID="home-logout"
      />
      <Button
        label={homeCopy.logoutAll}
        variant="secondary"
        loading={busy === 'logoutAll'}
        loadingLabel={homeCopy.loggingOutAll}
        disabled={busy === 'logout'}
        onPress={() => void logoutAll()}
        testID="home-logout-all"
      />
    </Screen>
  );
}
