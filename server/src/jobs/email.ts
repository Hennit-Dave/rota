import { z } from 'zod';
import type { JobContext, JobHandler } from './worker.js';
import { TerminalJobError } from './worker.js';
import { ResendError, type ResendClient } from './resend.js';

/**
 * The email job (jobs.md "External effects", ADR 0016). The work row's `payload` is the whole frozen request; this handler sends exactly that.
 *
 *  1. Skip, send nothing, if the invitation it belongs to was revoked, replaced by a resend, accepted or has expired: the link is dead.
 *  2. Write `first_attempt_at` (only if null) and COMMIT it before the first Resend call. Retries, recovery and rescheduling never reset it.
 *  3. No automatic send once 23 hours have passed since `first_attempt_at` (Resend keeps idempotency keys for 24): mark the row `failed`.
 *  4. Renew the lease right before the call; abort if ownership is lost.
 *  5. Send with the stable key `email-<rowId>`; record `sent_at` and Resend's message ID and scrub the body and link from the payload.
 * A row with `sent_at` never sends again.
 */
export const EMAIL_WINDOW_HOURS = 23;

const payloadSchema = z.object({
  from: z.string().min(1),
  replyTo: z.string().min(1).optional(),
  to: z.array(z.string().min(1)).min(1),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
  invitationId: z.string().regex(/^[0-9a-f-]{36}$/).optional(),
  // Magic-link and password-reset emails (ADR 0020): the auth token this email was made for.
  authTokenId: z.string().regex(/^[0-9a-f-]{36}$/).optional(),
  tokenHashHex: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export function emailIdempotencyKey(rowId: string): string {
  return `email-${rowId}`;
}

class OwnershipLostError extends Error {
  constructor(where: string) {
    super(`work row ownership lost ${where}`);
    this.name = 'OwnershipLostError';
  }
}

async function scrubPayload(ctx: JobContext): Promise<void> {
  // Removes the body and the link (the raw invite token) once they are no longer needed. Matched on all three ownership fields.
  await ctx.prisma.$executeRaw`
    UPDATE work_rows
    SET payload = (payload - 'html' - 'text') || '{"scrubbed": true}'::jsonb, updated_at = NOW()
    WHERE id = ${ctx.row.id}::uuid AND generation = ${ctx.row.generation}
      AND claim_token = ${ctx.claimToken}::uuid AND status = 'claimed'::"work_status"`;
}

export function createEmailHandler(deps: { resend: ResendClient }): JobHandler {
  return async (ctx) => {
    const { row, prisma } = ctx;
    const logBase = `[email] row_id=${row.id} generation=${row.generation} origin_request_id=${row.originRequestId ?? '-'}`;

    if (row.sentAt) {
      console.log(`${logBase} outcome=already_sent`);
      return;
    }

    const parsed = payloadSchema.safeParse(row.payload);
    if (!parsed.success) throw new TerminalJobError('invalid_payload');
    const payload = parsed.data;

    // 1. A dead invitation sends nothing (the older queued email of a resend, a revoked, accepted or expired one).
    if (payload.invitationId && payload.tokenHashHex) {
      const live = await prisma.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok FROM invitations
        WHERE id = ${payload.invitationId}::uuid AND token_hash = decode(${payload.tokenHashHex}, 'hex')
          AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`;
      if (live.length === 0) {
        await scrubPayload(ctx);
        console.log(`${logBase} outcome=skipped reason=invitation_not_pending`);
        return; // the processor marks the row done; sent_at stays null
      }
    }

    // 2 and 3. first_attempt_at, committed before the call, never reset; and the 23-hour rule against it.
    if (payload.authTokenId && payload.tokenHashHex) {
      // A magic link or reset email is only worth sending while its token can still be used: not redeemed, not replaced by a newer request,
      // not expired, not killed by a successful reset (ADR 0020). Same rule as the invitation check above.
      const live = await prisma.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok FROM auth_tokens
        WHERE id = ${payload.authTokenId}::uuid AND token_hash = decode(${payload.tokenHashHex}, 'hex')
          AND used_at IS NULL AND expires_at > NOW()`;
      if (live.length === 0) {
        await scrubPayload(ctx);
        console.log(`${logBase} outcome=skipped reason=auth_token_not_live`);
        return; // the processor marks the row done; sent_at stays null
      }
    }

    const stamped = await prisma.$queryRaw<Array<{ expired: boolean }>>`
      UPDATE work_rows
      SET first_attempt_at = COALESCE(first_attempt_at, NOW()), updated_at = NOW()
      WHERE id = ${row.id}::uuid AND generation = ${row.generation}
        AND claim_token = ${ctx.claimToken}::uuid AND status = 'claimed'::"work_status"
      RETURNING (NOW() - first_attempt_at) >= (${EMAIL_WINDOW_HOURS} || ' hours')::interval AS expired`;
    if (stamped.length === 0) throw new OwnershipLostError('before the first attempt stamp');
    if (stamped[0]!.expired) throw new TerminalJobError('email_window_expired');

    // 4. Renew right before the external call.
    if (!(await ctx.renewLease())) throw new OwnershipLostError('before the send');

    // 5. The send. The same key and the same stored payload on every attempt and every generation.
    let sent: { id: string };
    try {
      sent = await deps.resend.send({
        payload: { from: payload.from, replyTo: payload.replyTo, to: payload.to, subject: payload.subject, html: payload.html, text: payload.text },
        idempotencyKey: emailIdempotencyKey(row.id),
      });
    } catch (err) {
      if (err instanceof ResendError) {
        console.warn(`${logBase} outcome=${err.kind}_failure reason=${err.reason}${err.status === undefined ? '' : ` http=${err.status}`}`);
        if (err.reason === 'restricted_api_key' || err.reason === 'missing_api_key' || err.status === 401) {
          console.error(`${logBase} the Resend API key was refused; every email will fail until it is fixed`);
        }
        if (err.kind === 'terminal') throw new TerminalJobError(err.reason);
      }
      throw err; // retryable: the processor releases the claim and BullMQ retries with backoff
    }

    const recorded = await prisma.$executeRaw`
      UPDATE work_rows
      SET sent_at = NOW(), provider_message_id = ${sent.id},
          payload = (payload - 'html' - 'text') || '{"scrubbed": true}'::jsonb, updated_at = NOW()
      WHERE id = ${row.id}::uuid AND generation = ${row.generation}
        AND claim_token = ${ctx.claimToken}::uuid AND status = 'claimed'::"work_status" AND sent_at IS NULL`;
    if (recorded === 0) {
      // Resend accepted it but we no longer own the row. A later execution sends again with the SAME key, which Resend answers with the first
      // response without sending a second email, and then records it.
      throw new OwnershipLostError('after the send');
    }
    console.log(`${logBase} outcome=sent message_id=${sent.id}`);
  };
}
