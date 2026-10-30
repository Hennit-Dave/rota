// Test fixtures for billing (integration tests only). `seedActiveSubscription` writes what a REAL activation writes (a completed operation, the first period,
// the ledger rows, the subscription), so a team set up with it is a team that rebuilds from its ledger. Ledger rows can never be deleted (ADR 0026), so every
// call uses fresh random ids and leaves its rows on the TEST shard.
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { ledgerRowsForActivation } from './ledger.js';
import { CURRENCY, monthlyCents, type PlanId } from './plans.js';
import { anchorDayOf, periodNumber, utcDateOf } from './periods.js';

export async function seedActiveSubscription(
  db: PrismaClient,
  teamId: string,
  entitlements: { plan: PlanId; seats: number },
  options: { activationDate?: string; requestedByUserId?: string; period?: { startsOn: string; endsOn: string; periodDays: number } } = {},
): Promise<{ operationId: string; periodId: string; paymentIntentId: string }> {
  const operationId = randomUUID();
  const paymentIntentId = `pi_test_${randomUUID().replaceAll('-', '')}`;
  const activationDate = options.activationDate ?? utcDateOf(new Date());
  // A fixture may give the period explicitly (the $3.60 proof needs a 30-day period that ends 12 days from today, which no calendar anniversary gives).
  const period = options.period ?? periodNumber(activationDate, 0);
  const monthly = monthlyCents(entitlements);

  return db.$transaction(async (tx) => {
    const periodRows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO billing_periods (team_id, starts_on, ends_on, period_days)
      VALUES (${teamId}::uuid, ${period.startsOn}::date, ${period.endsOn}::date, ${period.periodDays}) RETURNING id`;
    const periodId = periodRows[0]!.id;
    await tx.$executeRaw`
      INSERT INTO payment_operations (id, team_id, kind, requested_by_user_id, base_version, activation_date, apply_plan, apply_seats, period_days, remaining_days,
        paid_basis_before_cents, gross_charge_cents, credit_cents, quote_cents, paid_basis_after_cents, status, stripe_payment_intent_id, completed_at, expires_at)
      VALUES (${operationId}::uuid, ${teamId}::uuid, 'activation'::payment_operation_kind, ${options.requestedByUserId ?? randomUUID()}::uuid, 0, ${activationDate}::date,
        ${entitlements.plan}::billing_plan, ${entitlements.seats}, ${period.periodDays}, ${period.periodDays}, 0, ${monthly}, 0, ${monthly}, ${monthly},
        'completed'::payment_operation_status, ${paymentIntentId}, NOW(), NOW())`;
    for (const row of ledgerRowsForActivation({ operationId, periodId, entitlements })) {
      await tx.$executeRaw`
        INSERT INTO ledger_entries (team_id, operation_id, entry_type, sequence, amount_cents, currency, period_id, plan, seats, paid_basis_after_cents, stripe_payment_intent_id)
        VALUES (${teamId}::uuid, ${row.operationId}::uuid, ${row.entryType}::ledger_entry_type, ${row.sequence}, ${row.amountCents}, ${CURRENCY}, ${row.periodId}::uuid,
          ${row.plan}::billing_plan, ${row.seats}, ${row.paidBasisAfterCents}, ${row.entryType === 'charge' ? paymentIntentId : null})`;
    }
    await tx.$executeRaw`
      INSERT INTO subscriptions (team_id, plan, seats, billing_anchor_day, paid_basis_cents, version, current_period_id, activated_at)
      VALUES (${teamId}::uuid, ${entitlements.plan}::billing_plan, ${entitlements.seats}, ${anchorDayOf(options.period?.startsOn ?? activationDate)}, ${monthly}, 1, ${periodId}::uuid, NOW())`;
    return { operationId, periodId, paymentIntentId };
  });
}
