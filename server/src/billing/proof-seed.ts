// Proof helper: gives a team on the TEST shards a real, active subscription whose current period has N days left, so a plan change can be proved against
// Stripe's sandbox on any day. It writes what a real activation writes (a completed operation, the period, the ledger rows, the subscription) through
// `seedActiveSubscription`. Run from server/:
//   npm run proof:seed-subscription -- <teamId> <plan> <seats> <daysLeft> [periodDays=30]
// Example: Team 15 seats with 12 days left in a 30-day period, then Team 15 to 18 is $3.60 (money.md, interview question 4).
// TEST shards only (createTestShards refuses anything else). The period is a fixture, not a calendar-anniversary period.
import { createTestShards } from '../db/clients.js';
import { shardFor } from '../db/shard.js';
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
  if (periodDays < 28 || periodDays > 31 || daysLeft < 1 || daysLeft > periodDays) throw new Error('periodDays is 28 to 31 and daysLeft is 1 to periodDays');

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
    const seeded = await seedActiveSubscription(db, teamId, { plan, seats }, { activationDate: startsOn, requestedByUserId: member.userId, period: { startsOn, endsOn, periodDays } });
    console.log(`seeded: ${plan} with ${seats} seats, period ${startsOn} to ${endsOn} (${periodDays} days, ${daysLeft} left today), activation operation ${seeded.operationId}`);
  } finally {
    await shards.A.primary.$disconnect();
    await shards.B.primary.$disconnect();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
