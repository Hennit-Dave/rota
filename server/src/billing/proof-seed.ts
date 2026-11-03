// Proof helper: gives a team on the TEST shards a real, active subscription whose current period has N days left, so a plan change can be proved against
// Stripe's sandbox on any day. It writes what a real activation writes (a completed operation, the period, the ledger rows, the subscription) through
// `seedActiveSubscription`. Run from server/:
//   npm run proof:seed-subscription -- <teamId> <plan> <seats> <daysLeft> [periodDays=30]
// daysLeft 0 gives a period that ENDED at 00:00 UTC today, so its renewal is due now (ADR 0031): the proof worker charges it as soon as it sees the row. The seed also
// queues that renewal on the proof queue (`work-proof`), so the worker that is already running picks it up.
// Example: Team 15 seats with 12 days left in a 30-day period, then Team 15 to 18 is $3.60 (money.md, interview question 4).
// TEST shards only (createTestShards refuses anything else). The period is a fixture, not a calendar-anniversary period.
import { createTestShards } from '../db/clients.js';
import { shardFor } from '../db/shard.js';
import { closeProducerQueue, enqueueCommittedRow, getProducerQueue } from '../jobs/queue.js';
import { isPlanId } from './plans.js';
import { seedActiveSubscription } from './testkit.js';

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function main() {
  const [teamId, plan, seatsArg, daysLeftArg, periodDaysArg] = process.argv.slice(2);
  const seats = Number(seatsArg);
  const daysLeft = Number(daysLeftArg);
  const periodDays = Number(periodDaysArg ?? 30);
  if (!teamId || !isPlanId(plan) || !Number.isInteger(seats) || !Number.isInteger(daysLeft) || !Number.isInteger(periodDays)) {
    throw new Error('usage: proof-seed <teamId> <starter|team|business> <seats> <daysLeft> [periodDays=30]');
  }
  if (periodDays < 28 || periodDays > 31 || daysLeft < 0 || daysLeft > periodDays) throw new Error('periodDays is 28 to 31 and daysLeft is 0 (already ended) to periodDays');

  // remaining = period_days - d + 1, where d is today's day number in the period (money.md): d = periodDays - daysLeft + 1.
  const dayOfPeriod = periodDays - daysLeft + 1;
  const todayUtc = Date.parse(`${iso(Date.now())}T00:00:00.000Z`);
  const startsOn = iso(todayUtc - (dayOfPeriod - 1) * DAY_MS);
  const endsOn = iso(todayUtc - (dayOfPeriod - 1) * DAY_MS + periodDays * DAY_MS);

  const shards = createTestShards({ primaryMax: 2 });
  try {
    const db = shards[shardFor(teamId)].primary;
    const member = await db.membership.findFirst({ where: { teamId, role: 'owner' }, select: { userId: true } });
    if (!member) throw new Error('no such team on the TEST shards (or it has no Owner)');
    const seeded = await seedActiveSubscription(db, teamId, { plan, seats }, { activationDate: startsOn, requestedByUserId: member.userId, period: { startsOn, endsOn, periodDays }, renewal: true });
    console.log(`seeded: ${plan} with ${seats} seats, period ${startsOn} to ${endsOn} (${periodDays} days, ${daysLeft} left today), activation operation ${seeded.operationId}`);
    if (seeded.renewalWork) {
      await enqueueCommittedRow(db, seeded.renewalWork, shardFor(teamId), () => getProducerQueue());
      console.log(`renewal ${seeded.renewalId} scheduled for ${endsOn} 00:00 UTC and queued`);
    }
  } finally {
    await closeProducerQueue();
    await shards.A.primary.$disconnect();
    await shards.B.primary.$disconnect();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
