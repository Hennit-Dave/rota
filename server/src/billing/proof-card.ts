// Proof helper (ADR 0031): puts a REAL Stripe sandbox card on a team on the TEST shards, so a renewal can be proved against Stripe's sandbox without going through the
// app's Checkout (which P6a already proved). It makes a sandbox Customer, attaches one of Stripe's test PaymentMethods, and records it as the team's active card exactly as
// P6a does (the older active card becomes `replaced`). Run from server/:
//   npm run proof:seed-card -- <teamId> <visa|decline|authentication|always> [existingCustomerId]
//     visa            4242 4242 4242 4242, charges fine
//     decline         4000 0000 0000 0341, attaches, then DECLINES when charged
//     authentication  4000 0025 0000 3155, attached WITHOUT being set up for off-session use
//     always          4000 0027 6000 3184, Stripe: authentication on EVERY payment
// TEST shards only (createTestShards refuses anything else) and a sk_test_ key only (loadStripeApiConfig refuses the rest).
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { createTestShards } from '../db/clients.js';
import { shardFor } from '../db/shard.js';
import { loadStripeApiConfig } from './stripeConfig.js';

const CARDS = {
  visa: { token: 'pm_card_visa', last4: '4242' },
  decline: { token: 'pm_card_chargeCustomerFail', last4: '0341' },
  authentication: { token: 'pm_card_authenticationRequiredSetupForOffSession', last4: '3155' },
  always: { token: 'pm_card_authenticationRequired', last4: '3184' },
} as const;

async function main() {
  const [teamId, which, existing] = process.argv.slice(2);
  const card = which && which in CARDS ? CARDS[which as keyof typeof CARDS] : undefined;
  if (!teamId || !card) throw new Error('usage: proof-card <teamId> <visa|decline|authentication|always> [existingCustomerId]');
  const config = loadStripeApiConfig();
  const stripe = new Stripe(config.secretKey, { timeout: config.timeoutMs });
  const shards = createTestShards({ primaryMax: 2 });
  try {
    const db = shards[shardFor(teamId)].primary;
    const known = existing ?? (await db.$queryRaw<Array<{ c: string }>>`SELECT stripe_customer_id AS c FROM team_payment_methods WHERE team_id = ${teamId}::uuid ORDER BY created_at DESC LIMIT 1`)[0]?.c;
    const customerId = known ?? (await stripe.customers.create({ description: `Rota renewal proof, team ${teamId}`, metadata: { team_id: teamId } })).id;
    const pm = await stripe.paymentMethods.attach(card.token, { customer: customerId });
    if (pm.livemode) throw new Error('refusing a live-mode payment method');
    const wording = 'By saving this card, you authorise Rota to charge this card the monthly price of your plan and seats on each renewal until you remove this card. Test mode only.';
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE team_payment_methods SET status = 'replaced'::saved_card_status, replaced_at = NOW(), updated_at = NOW() WHERE team_id = ${teamId}::uuid AND status = 'active'::saved_card_status`;
      await tx.$executeRaw`
        INSERT INTO team_payment_methods (team_id, stripe_customer_id, stripe_payment_method_id, card_brand, card_last4, card_exp_month, card_exp_year, source, source_id,
          consent_wording, consent_amount_cents, consent_anchor_day, consented_at)
        VALUES (${teamId}::uuid, ${customerId}, ${pm.id}, ${pm.card?.brand ?? 'visa'}, ${pm.card?.last4 ?? card.last4}, ${pm.card?.exp_month ?? 12}, ${pm.card?.exp_year ?? 2034},
          'card_setup'::saved_card_source, ${randomUUID()}::uuid, ${wording}, 5000, 1, NOW())`;
    });
    console.log(`saved: ${pm.card?.brand} ending ${pm.card?.last4} on a sandbox Customer, active for team ${teamId} (the payment method id stays server-side)`);
  } finally {
    await shards.A.primary.$disconnect();
    await shards.B.primary.$disconnect();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
