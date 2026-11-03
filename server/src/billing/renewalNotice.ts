// Telling the Owner that a renewal failed (ADR 0031): two emails, made when the renewal first fails and frozen as work rows (jobs.md: the whole request is stored, a retry
// sends exactly that). The Owner alone is told (issue #53). The in-app banner is the other half; it is derived from the renewal itself (renewalState.ts).
//
//   1. "we could not collect your renewal": sent at once, with the day the grace period ends.
//   2. "your team is now read-only": runs at the END of the grace period, and is skipped (the email job checks) if the renewal was paid in the meantime.
//
// PUSH HOOK: when the push slice lands (issue #53), add the push rows for the same two moments HERE, in `queueOwnerNotices`, Owner only. Nothing else changes: the
// moments are already decided by this module and each one already has its work row in the same transaction as the failure.
import { escapeHtml, formatExpiry, singleLine } from '../invites/emailTemplate.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { formatUsd } from './display.js';
import { TEST_MODE_NOTICE } from './display.js';
import { failureSentence } from './renewalState.js';

type Tx = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

export interface OwnerContact {
  email: string;
  name: string;
}

export interface Sender {
  from: string;
  replyTo: string;
}

/** A work row just written, ready for `enqueueCommittedRow` once the transaction that wrote it has committed. */
export interface NewWork {
  id: string;
  kind: string;
  generation: number;
  runAt: Date;
}

/** available_at = run_at + 2 minutes on normal creation (jobs.md). */
const SWEEP_GRACE_MS = 2 * 60 * 1000;

/** Writes a work row (inside the caller's transaction) and returns what `enqueueCommittedRow` needs. */
export async function insertWorkRow(tx: Tx, kind: string, payload: unknown, runAt: Date): Promise<NewWork> {
  const rows = await tx.$queryRaw<Array<{ id: string; generation: number; run_at: Date }>>`
    INSERT INTO work_rows (kind, payload, run_at, available_at, status, generation, execution_attempts)
    VALUES (${kind}, ${JSON.stringify(payload)}::jsonb, ${runAt}, ${new Date(runAt.getTime() + SWEEP_GRACE_MS)}, 'pending'::work_status, 1, 0)
    RETURNING id::text AS id, generation, run_at`;
  const row = rows[0]!;
  return { id: row.id, kind, generation: Number(row.generation), runAt: row.run_at };
}

export interface NoticeInput {
  teamName: string;
  timeZone: string;
  owner: OwnerContact;
  sender: Sender;
  renewalId: string;
  amountCents: number;
  failureCode: string;
  graceEndsAt: Date;
}

interface EmailParts {
  subject: string;
  text: string;
  html: string;
}

const wrap = (title: string, paragraphs: string[]): string => `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px;background:#f6f7f3;font-family:Arial,Helvetica,sans-serif;color:#152e2b;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;"><tr><td style="background:#ffffff;border:1px solid #d7e0d9;border-radius:16px;padding:32px;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:28px;font-weight:600;color:#152e2b;">${escapeHtml(title)}</h1>
${paragraphs.map((p, i) => `<p style="margin:0 0 ${i === paragraphs.length - 1 ? 0 : 16}px;font-size:${i === paragraphs.length - 1 ? 12 : 16}px;line-height:24px;color:${i === paragraphs.length - 1 ? '#586d68' : '#152e2b'};">${escapeHtml(p)}</p>`).join('\n')}
</td></tr></table></body></html>`;

/** Email 1: the renewal failed. Pure (the tests read it). */
export function renderRenewalFailedEmail(input: NoticeInput): EmailParts {
  const team = singleLine(input.teamName);
  const until = formatExpiry(input.graceEndsAt, input.timeZone);
  const paragraphs = [
    `We could not collect the ${formatUsd(input.amountCents)} renewal for ${team}. ${failureSentence(input.failureCode)}`,
    `${team} keeps full access ${until.replace(/^on /, 'until ')}. After that it becomes read-only: nobody can change shifts, swaps or invitations until the payment is made.`,
    'To fix it, open Rota, go to Billing, replace your card if needed, and choose Retry payment.',
    TEST_MODE_NOTICE,
  ];
  return { subject: `Rota: we could not collect ${team}'s renewal payment`, text: [`Payment problem for ${team}`, '', ...paragraphs.flatMap((p) => [p, ''])].join('\n').trim(), html: wrap(`Payment problem for ${team}`, paragraphs) };
}

/** Email 2: the grace period ended and the team is read-only. Pure. */
export function renderTeamReadOnlyEmail(input: NoticeInput): EmailParts {
  const team = singleLine(input.teamName);
  const paragraphs = [
    `${team} is now read-only because its ${formatUsd(input.amountCents)} renewal has not been paid. ${failureSentence(input.failureCode)}`,
    'Nobody can change shifts, swaps or invitations. Everyone can still sign in and look at their shifts, and you can still use Billing.',
    'To fix it, open Rota, go to Billing, replace your card if needed, and choose Retry payment. The team is writable again as soon as the payment is confirmed.',
    TEST_MODE_NOTICE,
  ];
  return { subject: `Rota: ${team} is now read-only`, text: [`${team} is read-only`, '', ...paragraphs.flatMap((p) => [p, ''])].join('\n').trim(), html: wrap(`${team} is read-only`, paragraphs) };
}

/**
 * Writes the Owner's two notices for a renewal that has just FAILED for the first time, in the failure's own transaction (jobs.md: Postgres first, then the queue). The
 * caller enqueues the returned rows after it commits. The second one is skipped by the email job if the renewal is paid before it runs.
 */
export async function queueOwnerNotices(tx: Tx, input: NoticeInput, now: Date): Promise<NewWork[]> {
  const base = { from: input.sender.from, replyTo: input.sender.replyTo, to: [input.owner.email], renewalId: input.renewalId };
  const failed = renderRenewalFailedEmail(input);
  const readOnly = renderTeamReadOnlyEmail(input);
  return [
    await insertWorkRow(tx, 'email', { ...base, ...failed }, now),
    // `skipIfRenewalPaid`: by the time the grace period ends the Owner may have paid, and then this email would be wrong.
    await insertWorkRow(tx, 'email', { ...base, ...readOnly, skipIfRenewalPaid: true }, input.graceEndsAt),
  ];
}
