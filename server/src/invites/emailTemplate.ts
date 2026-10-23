import type { Role } from '../teams/permissions.js';

/**
 * The invitation email (Figma 292:1006, placeholders 292:1019). Rendered ONCE, when the invitation is created or resent, and frozen as the
 * work row's payload (jobs.md): retries send exactly this, never a re-render. Colours are Figma's tokens (ink, muted, line, teal on paper).
 * Team and inviter names are user-typed, so everything inserted into HTML is escaped and everything in the subject is single-line.
 */
const INK = '#152e2b';
const MUTED = '#586d68';
const LINE = '#d7e0d9';
const TEAL = '#176b5b';
const PAPER = '#f6f7f3';

export interface InviteEmailInput {
  from: string;
  replyTo: string;
  to: string;
  inviterName: string;
  teamName: string;
  teamTimeZone: string;
  role: Role;
  /** `https://<host>/invite/<teamId>.<secret>` */
  link: string;
  expiresAt: Date;
}

export interface InviteEmailPayload {
  from: string;
  replyTo: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  /** Lets the email job skip a send whose invitation was revoked, replaced or has expired (ADR 0016). Not secret. */
  invitationId: string;
  /** Hex of the invitation's token hash when this email was made: a resend changes it, so the older queued email is skipped. Not secret. */
  tokenHashHex: string;
}

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', manager: 'Manager', staff: 'Staff' };

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** One line, no control characters, no leading or trailing space: safe in a subject and in a "From"-style display. */
export function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "on 30 October 2026 at 14:05 (Africa/Lagos)": the team's own time zone, so it reads the same to everyone on the team. */
export function formatExpiry(expiresAt: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(expiresAt);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(expiresAt);
  return `on ${date} at ${time} (${timeZone})`;
}

export function renderInviteEmail(
  input: InviteEmailInput & { invitationId: string; tokenHashHex: string },
): InviteEmailPayload {
  const inviter = singleLine(input.inviterName);
  const team = singleLine(input.teamName);
  const role = ROLE_LABEL[input.role];
  const expiry = formatExpiry(input.expiresAt, input.teamTimeZone);

  const subject = `${inviter} invited you to join ${team} on Rota`;
  const text = [
    `You're invited to join ${team}`,
    '',
    `${inviter} invited you to join ${team} as ${role}.`,
    '',
    `Join ${team}: ${input.link}`,
    '',
    `This invitation expires ${expiry}.`,
    '',
    "If you weren't expecting this email, you can ignore it.",
  ].join('\n');

  const eInviter = escapeHtml(inviter);
  const eTeam = escapeHtml(team);
  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px;background:${PAPER};font-family:Arial,Helvetica,sans-serif;color:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;"><tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:16px;padding:32px;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:28px;font-weight:600;color:${INK};">You&#39;re invited to join ${eTeam}</h1>
<p style="margin:0 0 24px;font-size:16px;line-height:24px;color:${INK};">${eInviter} invited you to join ${eTeam} as ${role}.</p>
<p style="margin:0 0 24px;"><a href="${escapeHtml(input.link)}" style="display:block;background:${TEAL};color:#ffffff;text-decoration:none;text-align:center;font-weight:600;font-size:16px;line-height:24px;padding:14px 16px;border-radius:12px;">Join ${eTeam}</a></p>
<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:${INK};">This invitation expires ${escapeHtml(expiry)}.</p>
<p style="margin:0;font-size:12px;line-height:18px;color:${MUTED};">If you weren&#39;t expecting this email, you can ignore it.</p>
</td></tr></table></body></html>`;

  return {
    from: input.from,
    replyTo: input.replyTo,
    to: [input.to],
    subject,
    html,
    text,
    invitationId: input.invitationId,
    tokenHashHex: input.tokenHashHex,
  };
}
