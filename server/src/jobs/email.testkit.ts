import { randomUUID } from 'node:crypto';
import type { Shards } from '../db/clients.js';
import { shardFor, type ShardId } from '../db/shard.js';
import type { PrismaClient, WorkRow } from '../generated/prisma/client.js';
import { renderInviteEmail } from '../invites/emailTemplate.js';
import { issueInviteToken } from '../invites/tokens.js';
import { ResendError, type ResendClient, type ResendPayload } from './resend.js';

/** Test helpers for the email job (not imported by the app). */

export type FakeStep = 'ok' | 'retryable' | 'quota' | 'bad_request' | 'lost_response';

/**
 * A fake Resend that behaves like the documented one where it matters: the SAME Idempotency-Key returns the first response without a second
 * delivery. `deliveries` counts distinct emails actually "sent". `lost_response` accepts the email and then fails the call (the answer is lost).
 */
export class FakeResend implements ResendClient {
  calls: Array<{ key: string; payload: ResendPayload }> = [];
  private byKey = new Map<string, string>();
  script: FakeStep[] = [];
  delayMs = 0;
  onCall: (() => Promise<void>) | null = null;

  get deliveries(): number {
    return this.byKey.size;
  }

  async send(request: { payload: ResendPayload; idempotencyKey: string }): Promise<{ id: string }> {
    this.calls.push({ key: request.idempotencyKey, payload: request.payload });
    await this.onCall?.();
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const step = this.script.shift() ?? 'ok';
    if (step === 'retryable') throw new ResendError('retryable', 'server_error', 500);
    if (step === 'quota') throw new ResendError('terminal', 'daily_quota_exceeded', 429);
    if (step === 'bad_request') throw new ResendError('terminal', 'validation_error', 422);
    const existing = this.byKey.get(request.idempotencyKey);
    const id = existing ?? `msg_${randomUUID()}`;
    this.byKey.set(request.idempotencyKey, id);
    if (step === 'lost_response') throw new ResendError('retryable', 'timeout');
    return { id };
  }
}

export interface MadeEmail {
  shard: ShardId;
  teamId: string;
  invitationId: string;
  workRowId: string;
  to: string;
  token: string;
  secret: string;
}

const created: Array<{ prisma: PrismaClient; teamId: string; workRowIds: string[] }> = [];

/** An invitation with its email work row, as the API writes them, on a chosen shard. Removed again by `cleanupEmails`. */
export async function makeInviteEmail(
  shards: Shards,
  shard: ShardId,
  opts: { runAt?: Date; availableAt?: Date; originRequestId?: string | null } = {},
): Promise<MadeEmail> {
  let teamId = randomUUID();
  while (shardFor(teamId) !== shard) teamId = randomUUID();
  const prisma = shards[shard].primary;
  const to = `invitee-${randomUUID()}@example.com`;
  const invitationId = randomUUID();
  const issued = issueInviteToken(teamId);
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);

  await prisma.team.create({ data: { id: teamId, name: 'The Olive Room', timeZone: 'Africa/Lagos' } });
  await prisma.invitation.create({
    data: { id: invitationId, teamId, email: to, role: 'staff', tokenHash: Uint8Array.from(issued.tokenHash), expiresAt, invitedByUserId: randomUUID() },
  });
  const payload = renderInviteEmail({
    from: 'Rota <notification@rota.davebuilds.design>',
    replyTo: 'rota@davebuilds.design',
    to,
    inviterName: 'Dave Hennit',
    teamName: 'The Olive Room',
    teamTimeZone: 'Africa/Lagos',
    role: 'staff',
    link: `https://rota.davebuilds.design/invite/${issued.token}`,
    expiresAt,
    invitationId,
    tokenHashHex: issued.tokenHash.toString('hex'),
  });
  const now = Date.now();
  const work = await prisma.workRow.create({
    data: {
      kind: 'email',
      payload: payload as unknown as object,
      originRequestId: opts.originRequestId === undefined ? randomUUID() : opts.originRequestId,
      runAt: opts.runAt ?? new Date(now - 1000),
      availableAt: opts.availableAt ?? new Date(now - 1000),
      status: 'pending',
      generation: 1,
    },
  });
  await prisma.invitation.update({ where: { id: invitationId }, data: { emailWorkRowId: work.id } });
  created.push({ prisma, teamId, workRowIds: [work.id] });
  return { shard, teamId, invitationId, workRowId: work.id, to, token: issued.token, secret: issued.token.split('.')[1]! };
}

/** Removes everything `makeInviteEmail` made. A sweep scans every pending row on a shard, so rows must not outlive their test. */
export async function cleanupEmails(): Promise<void> {
  for (const c of created.splice(0)) {
    await c.prisma.workRow.deleteMany({ where: { id: { in: c.workRowIds } } });
    await c.prisma.team.deleteMany({ where: { id: c.teamId } });
  }
}

export const job = (row: Pick<WorkRow, 'id'>, shard: ShardId, generation = 1) =>
  ({ id: `job-${row.id}-${generation}`, data: { rowId: row.id, generation, shard } }) as any;
