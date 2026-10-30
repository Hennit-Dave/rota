// Writing ledger rows (AGENTS.md rule 8: append-only; the database refuses UPDATE, DELETE and TRUNCATE). One function, used by every path that
// applies a change, so the column list and the "money rows carry the payment id" rule exist once.
import type { PrismaClient } from '../generated/prisma/client.js';
import type { LedgerRow } from './ledger.js';
import { CURRENCY } from './plans.js';

type Tx = Pick<PrismaClient, '$executeRaw'>;

/**
 * Inserts `rows` for a team. Money rows (a charge or a credit) carry the Stripe payment id when there is one; state rows (a period start or an entitlement
 * change) never do. A row that was already written (same operation, type and sequence) makes the insert fail: a payment applied twice writes nothing.
 */
export async function insertLedgerRows(tx: Tx, teamId: string, rows: readonly LedgerRow[], paymentIntentId: string | null): Promise<void> {
  for (const row of rows) {
    const isMoney = row.entryType === 'charge' || row.entryType === 'credit';
    await tx.$executeRaw`
      INSERT INTO ledger_entries (team_id, operation_id, entry_type, sequence, amount_cents, currency, period_id, plan, seats, paid_basis_after_cents, stripe_payment_intent_id)
      VALUES (${teamId}::uuid, ${row.operationId}::uuid, ${row.entryType}::ledger_entry_type, ${row.sequence}, ${row.amountCents}, ${CURRENCY}, ${row.periodId}::uuid,
        ${row.plan}::billing_plan, ${row.seats}, ${row.paidBasisAfterCents}, ${isMoney ? paymentIntentId : null})`;
  }
}
