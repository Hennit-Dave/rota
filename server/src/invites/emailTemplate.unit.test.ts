import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, formatExpiry, renderInviteEmail, singleLine } from './emailTemplate.js';

const base = {
  from: 'Rota <notification@rota.davebuilds.design>',
  replyTo: 'rota@davebuilds.design',
  to: 'sofia@example.com',
  inviterName: 'Dave Hennit',
  teamName: 'The Olive Room',
  teamTimeZone: 'Africa/Lagos',
  role: 'staff' as const,
  link: 'https://rota.davebuilds.design/invite/3f2b8c1e-9a4d-4e7b-b1c2-5d6e7f809a1b.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  expiresAt: new Date('2026-10-30T13:05:00.000Z'),
  invitationId: '11111111-1111-4111-8111-111111111111',
  tokenHashHex: 'a'.repeat(64),
};

test('the email follows the Figma template: subject, heading, role line, button, expiry, and the "ignore it" line', () => {
  const e = renderInviteEmail(base);
  assert.equal(e.subject, 'Dave Hennit invited you to join The Olive Room on Rota');
  assert.deepEqual(e.to, ['sofia@example.com']);
  assert.equal(e.from, base.from);
  assert.equal(e.replyTo, base.replyTo);
  for (const piece of [
    'You&#39;re invited to join The Olive Room',
    'Dave Hennit invited you to join The Olive Room as Staff.',
    'Join The Olive Room',
    'This invitation expires on 30 October 2026 at 14:05 (Africa/Lagos).',
    'If you weren&#39;t expecting this email, you can ignore it.',
  ]) {
    assert.ok(e.html.includes(piece), piece);
  }
  assert.ok(e.html.includes(`href="${base.link}"`));
  assert.ok(e.text.includes(base.link));
  assert.ok(e.text.includes('This invitation expires on 30 October 2026 at 14:05 (Africa/Lagos).'));
  assert.ok(!/\{(inviter|team|role|expiry)\}/.test(e.html + e.text + e.subject), 'no placeholder left unfilled');
  assert.equal(e.invitationId, base.invitationId);
  assert.equal(e.tokenHashHex, base.tokenHashHex);
});

test('the role label is the person-facing word for every invitable role', () => {
  assert.ok(renderInviteEmail({ ...base, role: 'manager' }).html.includes('as Manager.'));
  assert.ok(renderInviteEmail({ ...base, role: 'staff' }).html.includes('as Staff.'));
});

test('user-typed names are escaped: a team or inviter name cannot inject HTML', () => {
  const e = renderInviteEmail({ ...base, teamName: '<script>alert(1)</script>', inviterName: '"><img src=x onerror=alert(1)>' });
  assert.ok(!e.html.includes('<script>'));
  assert.ok(!e.html.includes('<img'));
  assert.ok(e.html.includes('&lt;script&gt;'));
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('the subject is one line even if a name contains line breaks or control characters', () => {
  const e = renderInviteEmail({ ...base, inviterName: 'Dave\r\nBcc: attacker@example.com', teamName: 'Olive\tRoom\u0000' });
  assert.ok(!/[\r\n\t\u0000]/.test(e.subject));
  assert.equal(singleLine('  a \n\n b c  '), 'a b c');
});

test('the expiry is written in the team\'s own time zone', () => {
  assert.equal(formatExpiry(new Date('2026-10-30T13:05:00.000Z'), 'Africa/Lagos'), 'on 30 October 2026 at 14:05 (Africa/Lagos)');
  assert.equal(formatExpiry(new Date('2026-10-30T13:05:00.000Z'), 'America/Chicago'), 'on 30 October 2026 at 08:05 (America/Chicago)');
  assert.equal(formatExpiry(new Date('2026-10-30T23:30:00.000Z'), 'Asia/Tokyo'), 'on 31 October 2026 at 08:30 (Asia/Tokyo)');
});
