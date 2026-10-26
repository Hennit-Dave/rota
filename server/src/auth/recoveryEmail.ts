import { escapeHtml } from '../invites/emailTemplate.js';

/**
 * The magic-link and password-reset emails (ADR 0020). Rendered ONCE when the token is created and frozen as the work row's payload (jobs.md,
 * ADR 0016): a retry sends exactly this. Same look as the invitation email (Figma tokens: ink, muted, line, teal on paper). Nothing user-typed goes
 * into the HTML, but everything inserted is escaped anyway. The expiry is relative ("in 10 minutes"), so no time zone is needed.
 */
const INK = '#152e2b';
const MUTED = '#586d68';
const LINE = '#d7e0d9';
const TEAL = '#176b5b';
const PAPER = '#f6f7f3';

export type RecoveryPurpose = 'magic_link' | 'password_reset';

export interface RecoveryEmailInput {
  from: string;
  replyTo: string;
  to: string;
  purpose: RecoveryPurpose;
  /** `https://<host>/magic/<secret>` or `https://<host>/reset/<secret>` */
  link: string;
  minutes: number;
  authTokenId: string;
  tokenHashHex: string;
}

export interface RecoveryEmailPayload {
  from: string;
  replyTo: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  /** Lets the email job skip a send whose token was used, replaced or has expired (ADR 0016, 0020). Not secret. */
  authTokenId: string;
  /** Hex of the token hash when this email was made: a newer request replaces the token, so the older queued email is skipped. Not secret. */
  tokenHashHex: string;
}

/** "10 minutes", "1 hour", "2 hours", "90 minutes". */
export function describeMinutes(minutes: number): string {
  if (minutes === 60) return '1 hour';
  if (minutes > 60 && minutes % 60 === 0) return `${minutes / 60} hours`;
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

const COPY: Record<RecoveryPurpose, { subject: string; heading: string; lead: string; button: string; ignore: string }> = {
  magic_link: {
    subject: 'Your Rota sign-in link',
    heading: 'Sign in to Rota',
    lead: 'Use this link to sign in. It works once.',
    button: 'Sign in to Rota',
    ignore: "If you didn't ask for this link, you can ignore this email. Nobody can sign in without it.",
  },
  password_reset: {
    subject: 'Reset your Rota password',
    heading: 'Reset your password',
    lead: 'Use this link to choose a new password for your Rota account. It works once.',
    button: 'Choose a new password',
    ignore: "If you didn't ask to reset your password, you can ignore this email. Your password has not changed.",
  },
};

export function renderRecoveryEmail(input: RecoveryEmailInput): RecoveryEmailPayload {
  const copy = COPY[input.purpose];
  const expiry = `This link expires in ${describeMinutes(input.minutes)}.`;

  const text = [copy.heading, '', copy.lead, '', `${copy.button}: ${input.link}`, '', expiry, '', copy.ignore].join('\n');

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px;background:${PAPER};font-family:Arial,Helvetica,sans-serif;color:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;"><tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:16px;padding:32px;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:28px;font-weight:600;color:${INK};">${escapeHtml(copy.heading)}</h1>
<p style="margin:0 0 24px;font-size:16px;line-height:24px;color:${INK};">${escapeHtml(copy.lead)}</p>
<p style="margin:0 0 24px;"><a href="${escapeHtml(input.link)}" style="display:block;background:${TEAL};color:#ffffff;text-decoration:none;text-align:center;font-weight:600;font-size:16px;line-height:24px;padding:14px 16px;border-radius:12px;">${escapeHtml(copy.button)}</a></p>
<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:${INK};">${escapeHtml(expiry)}</p>
<p style="margin:0;font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(copy.ignore)}</p>
</td></tr></table></body></html>`;

  return {
    from: input.from,
    replyTo: input.replyTo,
    to: [input.to],
    subject: copy.subject,
    html,
    text,
    authTokenId: input.authTokenId,
    tokenHashHex: input.tokenHashHex,
  };
}
