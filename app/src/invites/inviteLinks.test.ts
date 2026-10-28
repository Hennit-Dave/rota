import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, OfflineError } from '../api/errors';
import { json, makeHarness } from '../testkit';
import { createInviteApi } from './inviteApi';
import { invitationCaption, invitationTitle, invitationsCopy } from './invitationsCopy';
import { inviteCopy } from './inviteCopy';
import { inviteFormCopy } from './inviteFormCopy';
import { parseCreatedLink, parseInvitation, parseInvitePreview } from './inviteResponses';
import { inviteView, type PreviewState } from './inviteScreenState';
import { linkExpiryText } from './linkExpiry';
import { describeSendInviteFailure } from './sendInviteFailure';

// Invite links (ADR 0025, issue #37): the app side. The server decides everything; these pin what the app reads, sends and says.

const TEAM = '11111111-1111-4111-8111-111111111111';
const LINK = `https://rota.davebuilds.design/invite/${TEAM}.${'A'.repeat(43)}`;
const linkInvitation = { id: 'l1', kind: 'link', email: null, role: 'staff', expiresAt: '2026-10-30T18:33:23.352Z', emailStatus: null, canResend: false, canRevoke: true };
const linkPreview = { status: 'pending', kind: 'link', team: { name: 'The Olive Room' }, role: 'staff', inviter: { name: 'Dave Hennit', role: 'owner' }, email: null, account: 'none' };

test('creating a link sends nothing but the team (no address, no role) and reads the link from the answer', async () => {
  const h = makeHarness({ handler: () => json(201, { invitation: linkInvitation, link: LINK }) });
  const made = await createInviteApi(h.client).createInviteLink(TEAM);
  assert.equal(made.link, LINK);
  assert.deepEqual([made.invitation.kind, made.invitation.email, made.invitation.emailStatus, made.invitation.role, made.invitation.canResend], ['link', null, null, 'staff', false]);
  assert.equal(h.calls[0]?.method, 'POST');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/invitations/links`);
  assert.equal(h.calls[0]?.body, undefined, 'no body: a link is always Staff and has no address');
  assert.equal(h.calls[0]?.authorization, 'Bearer old');
});

test('a link answer that is not exactly a link is refused: no link text, an invitation with an address, or an email invitation', () => {
  assert.equal(parseCreatedLink({ invitation: linkInvitation, link: LINK }).link, LINK);
  for (const bad of [
    null,
    {},
    { invitation: linkInvitation },
    { invitation: linkInvitation, link: '' },
    { invitation: { ...linkInvitation, email: 'a@example.com' }, link: LINK },
    { invitation: { ...linkInvitation, emailStatus: 'queued' }, link: LINK },
    { invitation: { ...linkInvitation, kind: 'email', email: 'a@example.com', emailStatus: 'queued' }, link: LINK },
  ]) {
    assert.throws(() => parseCreatedLink(bad), (e) => e instanceof ApiError && e.code === 'invalid_response', JSON.stringify(bad));
  }
});

test('the pending list reads a link row (no address, no email state) next to an email row', () => {
  const email = { id: 'e1', kind: 'email', email: 'sofia@example.com', role: 'staff', expiresAt: '2026-10-30T18:33:23.352Z', emailStatus: 'sent', canResend: true, canRevoke: true };
  const a = parseInvitation(email);
  const b = parseInvitation(linkInvitation);
  assert.equal(invitationTitle(a), 'sofia@example.com');
  assert.equal(invitationTitle(b), 'Invite link', 'a link has no address to show');
  assert.deepEqual(invitationCaption(b), { text: 'Pending · Staff', tone: 'muted' }, 'and no "Email not sent": it sends none');
  assert.equal(b.canResend, false, 'the server says there is nothing to resend');
  for (const bad of [{ ...email, email: null }, { ...email, emailStatus: null }, { ...linkInvitation, email: 'x@example.com' }, { ...linkInvitation, kind: 'other' }]) {
    assert.throws(() => parseInvitation(bad), (e) => e instanceof ApiError && e.code === 'invalid_response', JSON.stringify(bad));
  }
});

test('revoking a link says so in its own words, and never shows an address', () => {
  assert.equal(invitationsCopy.revokeConfirm.title(null), 'Revoke this invite link?');
  assert.equal(invitationsCopy.revokeConfirm.title('sofia@example.com'), 'Revoke invitation for sofia@example.com?');
});

test('a link preview has no address and may be "open" to any signed-in account; an email preview must have its address', () => {
  const p = parseInvitePreview(linkPreview);
  assert.deepEqual([p.status === 'pending' && p.kind, p.status === 'pending' && p.email], ['link', null]);
  assert.equal(parseInvitePreview({ ...linkPreview, account: 'open' }).status, 'pending');
  for (const bad of [{ ...linkPreview, email: 'a@example.com' }, { ...linkPreview, kind: 'email' }, { ...linkPreview, kind: undefined }, { ...linkPreview, account: 'maybe' }]) {
    assert.throws(() => parseInvitePreview(bad), (e) => e instanceof ApiError && e.code === 'invalid_response', JSON.stringify(bad));
  }
});

test('the invite screen for a link: signed out it asks to sign in or create ANY account; signed in it goes straight to accept (never "wrong account")', () => {
  const state = (account: string): PreviewState => ({ status: 'success', data: parseInvitePreview({ ...linkPreview, account }) });
  const out = inviteView({ session: 'signedOut', token: 't', preview: state('none'), acceptFailure: null });
  assert.equal(out.kind, 'signed_out');
  assert.equal(inviteView({ session: 'signedIn', token: 't', preview: state('open'), acceptFailure: null }).kind, 'confirm');
  assert.equal(inviteView({ session: 'signedIn', token: 't', preview: state('none'), acceptFailure: null }).kind, 'confirm', 'an expired access token: accept decides');
  assert.match(inviteCopy.signedOut.bodyLink, /any|an account/i);
  assert.equal(inviteCopy.signedOut.bodyLink.includes('@'), false, 'no address is mentioned');
});

test('a link already used by this account takes them to their team; a used link for anyone else is the usual "isn\'t available"', () => {
  const team = { id: TEAM, name: 'The Olive Room', timeZone: 'Africa/Lagos', role: 'staff' as const };
  const already: PreviewState = { status: 'success', data: { status: 'already_member', team } };
  assert.equal(inviteView({ session: 'signedIn', token: 't', preview: already, acceptFailure: null }).kind, 'already_member');
  const gone: PreviewState = { status: 'error', error: new ApiError(404, 'invite_unavailable', 'x', null) };
  assert.equal(inviteView({ session: 'signedIn', token: 't', preview: gone, acceptFailure: null }).kind, 'unavailable');
});

test('when the link stops working is the server\'s instant, shown on the team\'s clock', () => {
  assert.equal(linkExpiryText('2026-10-30T13:05:00.000Z', 'Africa/Lagos'), 'Fri 30 Oct, 14:05');
  assert.equal(linkExpiryText('2026-10-30T13:05:00.000Z', 'America/New_York'), 'Fri 30 Oct, 09:05');
  assert.equal(linkExpiryText('not a date', 'Africa/Lagos'), null);
  assert.equal(linkExpiryText('2026-10-30T13:05:00.000Z', undefined), null);
});

test('creating a link fails in words: the team is at its limit, offline, not allowed, rate limited', () => {
  assert.deepEqual(describeSendInviteFailure(new ApiError(409, 'invite_link_limit', 'x', 'r1')), { kind: 'link_limit', message: inviteFormCopy.link.limit });
  assert.equal(describeSendInviteFailure(new OfflineError())?.kind, 'offline');
  assert.equal(describeSendInviteFailure(new ApiError(403, 'forbidden', 'x', null))?.kind, 'not_allowed');
  assert.equal(describeSendInviteFailure(new ApiError(429, 'rate_limited', 'x', null, undefined, 30))?.kind, 'rate_limited');
  assert.equal(describeSendInviteFailure(new ApiError(500, 'internal_error', 'x', 'r2'))?.kind, 'generic');
});

test('the words about a link say plainly what a link is, and the share message carries the link and the team', () => {
  const c = inviteFormCopy.link;
  assert.match(c.bannerTitle, /Anyone with this link can join once/);
  assert.match(c.bannerBody, /Staff/);
  assert.match(c.bannerBody, /won’t see this link again/);
  assert.equal(c.shareMessage('The Olive Room', LINK), `Join The Olive Room on Rota: ${LINK}`);
  assert.equal(c.shareMessage(undefined, LINK), `Join my team on Rota: ${LINK}`);
});
