import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useRef, useState } from 'react';
import { Share } from 'react-native';
import { bannerCopy } from '../../../auth/copy';
import { useMe } from '../../../auth/useMe';
import { createInviteApi } from '../../../invites/inviteApi';
import { invitationsQueryKey } from '../../../invites/useInvitations';
import { inviteFormCopy } from '../../../invites/inviteFormCopy';
import { roleChoice, validateInviteEmail } from '../../../invites/inviteFormState';
import { roleLabel } from '../../../invites/inviteCopy';
import { linkExpiryText } from '../../../invites/linkExpiry';
import type { InvitationView } from '../../../invites/inviteResponses';
import { describeSendInviteFailure, type SendInviteFailure } from '../../../invites/sendInviteFailure';
import { getApi, queryClient } from '../../../services';
import { useSessionStore } from '../../../state/sessionStore';
import { teamCopy } from '../../../teams/teamCopy';
import { teamDetailQueryKey, type InvitableRole } from '../../../teams/teamResponses';
import { useTeamDetail } from '../../../teams/useTeamData';
import { space } from '../../../theme';
import { Button } from '../../../ui/Button';
import { useFocusSink } from '../../../ui/FocusSink';
import { createLatch } from '../../../ui/latch';
import { OptionSheet } from '../../../ui/OptionSheet';
import { PageHeader } from '../../../ui/PageHeader';
import { PersonCard } from '../../../ui/PersonCard';
import { Screen, Spacer } from '../../../ui/Screen';
import { SelectField } from '../../../ui/SelectField';
import { StatusBanner } from '../../../ui/StatusBanner';
import { Text } from '../../../ui/Text';
import { TextField, type TextFieldHandle } from '../../../ui/TextField';
import { useOnline } from '../../../ui/useOnline';

/**
 * Invite a teammate (Figma 8:209 and its states 291:655 to 291:932, role sheet 291:963, Manager view 103:2462), then "Invitation sent" (8:229).
 * Only the address and the role are sent; the team comes from the route's selected team and the inviter from the session. The roles offered are exactly
 * what the server says this person may grant (an Owner: Manager or Staff; a Manager: Staff only, shown disabled). The email is sent later by the
 * worker, so "Email queued" is all the server can promise here. Button behaviour follows Figma note 232:415: disabled only while loading or offline,
 * enabled on every error.
 */
export default function InviteScreen() {
  return <InviteForm />;
}

const sendInvitation = (teamId: string, input: { email: string; role: InvitableRole }) => createInviteApi(getApi()).createInvitation(teamId, input);
const createLink = (teamId: string) => createInviteApi(getApi()).createInviteLink(teamId);
const resendInvitation = (teamId: string, invitationId: string) => createInviteApi(getApi()).resendInvitation(teamId, invitationId);

function InviteForm() {
  const online = useOnline();
  const focusSink = useFocusSink();
  const me = useMe();
  const userId = me.data?.id;
  const teamId = useSessionStore((s) => s.selectedTeamId);
  const detail = useTeamDetail(userId, teamId);

  const [email, setEmail] = useState('');
  const [chosen, setChosen] = useState<InvitableRole | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [emailError, setEmailError] = useState<string | undefined>();
  const [failure, setFailure] = useState<Exclude<SendInviteFailure, { kind: 'fields' }> | null>(null);
  const [sent, setSent] = useState<InvitationView | null>(null);
  const [made, setMade] = useState<{ invitation: InvitationView; link: string } | null>(null);
  const emailRef = useRef<TextFieldHandle>(null);
  // One send at a time, decided synchronously: the button only greys out after React renders again, and two quick taps can both arrive first.
  const [sendLatch] = useState(createLatch);
  const [linkLatch] = useState(createLatch);

  const choice = detail.data ? roleChoice(detail.data.invitableRoles, chosen) : null;
  const teamName = detail.data?.team.name;

  const send = useMutation({
    networkMode: 'always', // never queued offline (app-state.md): it fails at once and can be tapped again
    retry: 0,
    mutationFn: (input: { email: string; role: InvitableRole }) => sendInvitation(teamId as string, input),
    onSuccess: (invitation) => {
      setSent(invitation);
      if (userId && teamId) void queryClient.invalidateQueries({ queryKey: invitationsQueryKey(userId, teamId) });
    },
    onError: (error) => {
      const result = describeSendInviteFailure(error);
      if (result === null) return;
      if (result.kind === 'fields') {
        setEmailError(result.fields.email);
        emailRef.current?.focus();
      } else {
        setFailure(result);
        // The server says this person may not invite here (their role changed): drop the stale answer so the entry points follow.
        if (result.kind === 'not_allowed' && userId && teamId) void queryClient.invalidateQueries({ queryKey: teamDetailQueryKey(userId, teamId) });
      }
    },
    onSettled: () => sendLatch.release(),
  });

  // An invite link (ADR 0025): nothing but the team is sent; the server decides who may and answers with the link, which exists only in this answer.
  const makeLink = useMutation({
    networkMode: 'always', // never queued offline (app-state.md)
    retry: 0,
    mutationFn: () => createLink(teamId as string),
    onSuccess: (result) => {
      setMade(result);
      if (userId && teamId) void queryClient.invalidateQueries({ queryKey: invitationsQueryKey(userId, teamId) });
    },
    onError: (error) => {
      const result = describeSendInviteFailure(error);
      if (result === null) return;
      setFailure(result.kind === 'fields' ? { kind: 'generic', message: bannerCopy.generic, reference: null } : result);
      if (result.kind === 'not_allowed' && userId && teamId) void queryClient.invalidateQueries({ queryKey: teamDetailQueryKey(userId, teamId) });
    },
    onSettled: () => linkLatch.release(),
  });

  function submit() {
    if (!choice || !sendLatch.tryAcquire()) return;
    const error = validateInviteEmail(email);
    setEmailError(error);
    setFailure(null);
    if (error) {
      sendLatch.release();
      emailRef.current?.focus();
      return;
    }
    // The focused field is about to be disabled: park focus on the hidden sink first (closes the keyboard too).
    focusSink();
    send.mutate({ email, role: choice.selected });
  }

  if (made) {
    return <InviteLinkReady made={made} teamName={teamName} timeZone={detail.data?.team.timeZone} />;
  }

  if (sent) {
    return (
      <InviteSent
        invitation={sent}
        userId={userId}
        teamId={teamId}
        teamName={teamName}
        online={online}
        onChange={setSent}
      />
    );
  }

  if (!detail.data) {
    return (
      <Screen gap={space[16]}>
        <PageHeader teamName={teamName} title={inviteFormCopy.title} subtitle={inviteFormCopy.subtitle} />
        {detail.isError ? (
          <>
            <StatusBanner tone="error" title={bannerCopy.generic} />
            <Button label={teamCopy.retry} variant="secondary" onPress={() => void detail.refetch()} testID="invite-form-retry" />
          </>
        ) : (
          <Text variant="caption" tone="muted">
            {inviteFormCopy.loadingPermissions}
          </Text>
        )}
      </Screen>
    );
  }

  if (!choice) {
    // The server offers this person no role to invite (a Staff member who got here by a stale screen or a link). Nothing can be sent.
    return (
      <Screen gap={space[16]}>
        <PageHeader teamName={teamName} title={inviteFormCopy.title} subtitle={inviteFormCopy.subtitle} />
        <StatusBanner tone="warning" title={inviteFormCopy.notAllowed} />
        <Spacer />
        <Button label={inviteFormCopy.sent.backToTeam} onPress={() => router.back()} testID="invite-not-allowed-back" />
      </Screen>
    );
  }

  const submitting = send.isPending;
  let banner: React.ReactNode = null;
  if (!online) {
    banner = <StatusBanner tone="warning" title={inviteFormCopy.offline} />;
  } else if (failure?.kind === 'rate_limited' || failure?.kind === 'offline' || failure?.kind === 'not_allowed' || failure?.kind === 'link_limit') {
    banner = <StatusBanner tone="warning" title={failure.message} />;
  } else if (failure?.kind === 'generic') {
    banner = (
      <StatusBanner tone="error" title={failure.message} reference={failure.reference ? `${bannerCopy.referencePrefix}${failure.reference}` : undefined} />
    );
  }

  return (
    <Screen gap={space[16]}>
      <PageHeader teamName={teamName} title={inviteFormCopy.title} subtitle={inviteFormCopy.subtitle} />
      <TextField
        label={inviteFormCopy.emailLabel}
        helper={inviteFormCopy.emailHelper}
        value={email}
        onChangeText={(value) => {
          setEmail(value);
          setEmailError(undefined);
        }}
        error={emailError}
        disabled={submitting}
        inputRef={emailRef}
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        keyboardType="email-address"
        returnKeyType="go"
        onSubmitEditing={submit}
        testID="invite-email"
      />
      <SelectField
        label={inviteFormCopy.roleLabel}
        helper={inviteFormCopy.roleHelper}
        value={roleLabel[choice.selected]}
        placeholder=""
        onPress={() => setSheetOpen(true)}
        disabled={!choice.canChoose || submitting}
        testID="invite-role"
      />
      {banner}
      {/* Shown only when the server says this person may make one (`canCreateInviteLink`, the permission table). */}
      {detail.data.canCreateInviteLink ? (
        <>
          <Text variant="caption" tone="muted">
            {inviteFormCopy.link.actionHelper}
          </Text>
          <Button
            label={inviteFormCopy.link.action}
            variant="outline"
            loading={makeLink.isPending}
            loadingLabel={inviteFormCopy.link.creating}
            disabled={!online || submitting}
            onPress={() => {
              if (!linkLatch.tryAcquire()) return;
              setFailure(null);
              makeLink.mutate();
            }}
            testID="invite-create-link"
          />
        </>
      ) : null}
      <Spacer />
      <Button
        label={inviteFormCopy.submit}
        loading={submitting}
        loadingLabel={inviteFormCopy.submit}
        disabled={!online || makeLink.isPending}
        onPress={submit}
        testID="invite-submit"
      />
      <OptionSheet
        visible={sheetOpen}
        title={inviteFormCopy.sheetTitle}
        options={choice.options.map((role) => ({ value: role, label: roleLabel[role] }))}
        selected={choice.selected}
        onSelect={(value) => {
          setChosen(value as InvitableRole);
          setSheetOpen(false);
        }}
        onClose={() => setSheetOpen(false)}
      />
    </Screen>
  );
}

/** Invitation sent (Figma 8:229). Resend gives the same invitation a new link and a new email (the old link stops working). */
function InviteSent(props: {
  invitation: InvitationView;
  userId: string | undefined;
  teamId: string | null;
  teamName: string | undefined;
  online: boolean;
  onChange: (invitation: InvitationView) => void;
}) {
  const { invitation, userId, teamId, teamName, online, onChange } = props;
  const copy = inviteFormCopy.sent;
  const [problem, setProblem] = useState<SendInviteFailure | null>(null);
  const [resendLatch] = useState(createLatch);

  const resend = useMutation({
    networkMode: 'always',
    retry: 0,
    mutationFn: () => resendInvitation(teamId as string, invitation.id),
    onMutate: () => setProblem(null),
    onSuccess: (next) => {
      onChange(next);
      if (userId && teamId) void queryClient.invalidateQueries({ queryKey: invitationsQueryKey(userId, teamId) });
    },
    onError: (error) => setProblem(describeSendInviteFailure(error)),
    onSettled: () => resendLatch.release(),
  });

  let banner: React.ReactNode = <StatusBanner tone="info" title={copy.queuedTitle} body={copy.queuedBody} />;
  if (problem?.kind === 'rate_limited' || problem?.kind === 'offline' || problem?.kind === 'not_allowed') {
    banner = <StatusBanner tone="warning" title={problem.message} />;
  } else if (problem) {
    banner = <StatusBanner tone="error" title={copy.resendFailedTitle} body={copy.resendFailedBody} />;
  }

  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} teamName={teamName} title={copy.title} subtitle={copy.subtitle(invitation.email ?? '')} />
      {banner}
      <PersonCard title={invitation.email ?? ''} caption={copy.pending(roleLabel[invitation.role])} testID="invite-sent-card" />
      <Spacer />
      <Button label={copy.backToTeam} onPress={() => router.back()} testID="invite-sent-back" />
      {invitation.canResend ? (
        <Button
          label={copy.resend}
          variant="secondary"
          loading={resend.isPending}
          loadingLabel={copy.resending}
          disabled={!online}
          onPress={() => {
            if (resendLatch.tryAcquire()) resend.mutate();
          }}
          testID="invite-resend"
        />
      ) : null}
    </Screen>
  );
}

/**
 * Invite link ready (ADR 0025). The link is shown ONCE: the server keeps only its hash, so a link lost here is revoked and made again. Copy puts it on the
 * clipboard (expo-clipboard, already in the build) and Share opens the system share sheet (React Native's own `Share`): neither needs a new native build.
 * Nothing logs the link. "Anyone with this link can join once" is said plainly, because that is what a link is.
 */
function InviteLinkReady(props: { made: { invitation: InvitationView; link: string }; teamName: string | undefined; timeZone: string | undefined }) {
  const { made, teamName, timeZone } = props;
  const copy = inviteFormCopy.link;
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const until = linkExpiryText(made.invitation.expiresAt, timeZone);

  async function copyLink() {
    try {
      await Clipboard.setStringAsync(made.link);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <Screen gap={space[16]}>
      <PageHeader eyebrowGap={16} teamName={teamName} title={copy.title} subtitle={until ? copy.subtitle(until) : undefined} />
      <StatusBanner tone="info" title={copy.bannerTitle} body={copy.bannerBody} />
      {copied === 'failed' ? <StatusBanner tone="warning" title={copy.copyFailed} /> : null}
      <PersonCard title={copy.cardTitle} caption={copy.pending(roleLabel[made.invitation.role])} testID="invite-link-card" />
      <Text variant="caption" tone="muted" selectable testID="invite-link-text">
        {made.link}
      </Text>
      <Spacer />
      <Button label={copied === 'copied' ? copy.copied : copy.copy} onPress={() => void copyLink()} testID="invite-link-copy" />
      <Button
        label={copy.share}
        variant="secondary"
        onPress={() => void Share.share({ message: copy.shareMessage(teamName, made.link) }).catch(() => {})}
        testID="invite-link-share"
      />
      <Button label={copy.backToTeam} variant="outline" onPress={() => router.back()} testID="invite-link-back" />
    </Screen>
  );
}
