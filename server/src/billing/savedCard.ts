// The team's saved card (ADR 0030): what is stored, what the app is shown, how a card is recorded and removed. We never see a card number: Stripe holds the card, we
// keep its ids, the display fields it returns (brand, last four, expiry) and the consent the Owner gave. Nothing here moves money or touches the ledger.
// The app is shown finished strings only; it never receives a Customer or a PaymentMethod id.
import { getShard, type Shards } from '../db/clients.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { ApiError } from '../http/errors.js';

type Tx = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

const BRAND_NAMES: Readonly<Record<string, string>> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  eftpos_au: 'EFTPOS',
  cartes_bancaires: 'Cartes Bancaires',
};

export function brandName(brand: string): string {
  return BRAND_NAMES[brand] ?? 'Card';
}

/** 8, 2027 -> "08/2027". Text only: no date arithmetic. */
export function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, '0')}/${String(year)}`;
}

/** What the app shows about the saved card. Finished strings only. */
export interface SavedCardView {
  summary: string;
  expiresDisplay: string;
  /** The wording the Owner agreed to, exactly as shown on Stripe's page. */
  consentWording: string;
  /** The UTC calendar day the agreement was recorded, as `YYYY-MM-DD`. */
  consentedOn: string;
}

interface CardRow {
  card_brand: string;
  card_last4: string;
  card_exp_month: number;
  card_exp_year: number;
  consent_wording: string;
  consented_on: string;
}

export function viewOfCard(row: CardRow): SavedCardView {
  return {
    summary: `${brandName(row.card_brand)} ending ${row.card_last4}`,
    expiresDisplay: `Expires ${formatExpiry(row.card_exp_month, row.card_exp_year)}`,
    consentWording: row.consent_wording,
    consentedOn: row.consented_on,
  };
}

/** The team's active card, or null. Read from the primary and never cached (a payment method decides what we may charge: rule 11). */
export async function getSavedCard(shards: Shards, teamId: string): Promise<SavedCardView | null> {
  const rows = await getShard(shards, teamId).primary.$queryRaw<CardRow[]>`
    SELECT card_brand, card_last4, card_exp_month, card_exp_year, consent_wording, to_char(consented_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS consented_on
    FROM team_payment_methods WHERE team_id = ${teamId}::uuid AND status = 'active'::saved_card_status`;
  return rows[0] ? viewOfCard(rows[0]) : null;
}

/** The Stripe Customer this team's cards live on, or null. A new card goes on the same Customer, so the team never has two. Server-side only. */
export async function customerIdOf(db: Pick<PrismaClient, '$queryRaw'>, teamId: string): Promise<string | null> {
  const rows = await db.$queryRaw<Array<{ stripe_customer_id: string }>>`
    SELECT stripe_customer_id FROM team_payment_methods WHERE team_id = ${teamId}::uuid ORDER BY created_at DESC, id DESC LIMIT 1`;
  return rows[0]?.stripe_customer_id ?? null;
}

export interface NewCard {
  teamId: string;
  customerId: string;
  paymentMethodId: string;
  card: { brand: string; last4: string; expMonth: number; expYear: number };
  source: 'activation' | 'card_setup';
  sourceId: string;
  consentWording: string;
  consentAmountCents: number;
  consentAnchorDay: number;
  consentedAt: Date;
}

export type InsertCardResult = 'inserted' | 'duplicate' | 'customer_mismatch' | 'belongs_to_another_team';

/**
 * Records a card as the team's active card, in the caller's transaction (which holds the team row lock). The older active card, if any, becomes `replaced`.
 * Idempotent by the Stripe PaymentMethod id: a replayed event finds the card and writes nothing. A card for another Stripe Customer than the team's is refused.
 */
export async function insertActiveCard(tx: Tx, card: NewCard): Promise<InsertCardResult> {
  const same = await tx.$queryRaw<Array<{ team_id: string }>>`SELECT team_id::text AS team_id FROM team_payment_methods WHERE stripe_payment_method_id = ${card.paymentMethodId}`;
  if (same[0]) return same[0].team_id === card.teamId ? 'duplicate' : 'belongs_to_another_team';

  const known = await customerIdOf(tx, card.teamId);
  if (known !== null && known !== card.customerId) return 'customer_mismatch';

  await tx.$executeRaw`
    UPDATE team_payment_methods SET status = 'replaced'::saved_card_status, replaced_at = NOW(), updated_at = NOW()
    WHERE team_id = ${card.teamId}::uuid AND status = 'active'::saved_card_status`;
  await tx.$executeRaw`
    INSERT INTO team_payment_methods (team_id, stripe_customer_id, stripe_payment_method_id, card_brand, card_last4, card_exp_month, card_exp_year, source, source_id,
      consent_wording, consent_amount_cents, consent_anchor_day, consented_at)
    VALUES (${card.teamId}::uuid, ${card.customerId}, ${card.paymentMethodId}, ${card.card.brand}, ${card.card.last4}, ${card.card.expMonth}, ${card.card.expYear},
      ${card.source}::saved_card_source, ${card.sourceId}::uuid, ${card.consentWording}, ${card.consentAmountCents}, ${card.consentAnchorDay}, ${card.consentedAt})`;
  return 'inserted';
}

/**
 * Withdraws the authorisation: the active card is marked `removed` and we never charge it again. The card stays attached to the Customer on Stripe's side
 * (detaching it is a second Stripe call, left for a later slice; ADR 0030): what we may charge is decided by OUR table. No active card: 404.
 */
export async function removeSavedCard(shards: Shards, teamId: string): Promise<void> {
  const changed = await getShard(shards, teamId).primary.$executeRaw`
    UPDATE team_payment_methods SET status = 'removed'::saved_card_status, removed_at = NOW(), updated_at = NOW()
    WHERE team_id = ${teamId}::uuid AND status = 'active'::saved_card_status`;
  if (changed === 0) throw new ApiError('not_found', { reason: 'no_saved_card' });
}
