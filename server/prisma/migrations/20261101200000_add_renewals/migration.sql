-- Renewals and failed renewals (ADR 0031, payments slice P6b; money.md "Renewals and failed renewals"). The same migration runs on BOTH shards (data.md).
-- Purely additive: one enum and one table. No existing row is touched, and nothing here moves money or changes the ledger.
--
-- One row per team per billing period: "the period that ends is renewed". It is the durable record of the renewal (the work row only carries it to the worker),
-- of the charge attempt (the frozen amount and entitlements, the attempt number, the Stripe PaymentIntent), and of a failure (when it began, why, and when the
-- grace period ends). "Past due" and "read-only" are DERIVED from this table; no flag on the subscription can drift from it.
-- There is deliberately NO foreign key to "teams" (a team's money history outlives the team row, ADR 0026).

CREATE TYPE "renewal_status" AS ENUM ('scheduled', 'retry_requested', 'charging', 'past_due', 'paid', 'needs_review');

CREATE TABLE "renewals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    -- The period that is ending (the one being renewed). The next period is created only when the payment is confirmed.
    "period_id" UUID NOT NULL,
    "status" "renewal_status" NOT NULL DEFAULT 'scheduled',
    -- 00:00 UTC on the period's end date: when the first attempt may run.
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    -- Frozen when an attempt starts, so the amount charged is the amount applied: the subscription version it was worked out against, the entitlements the new
    -- period will have (after any scheduled reduction), the scheduled change it applies, and the monthly amount of those entitlements (integer cents).
    "base_version" INTEGER,
    "result_plan" "billing_plan",
    "result_seats" INTEGER,
    "scheduled_change_id" UUID,
    "amount_cents" INTEGER,
    -- Attempt 1 is the automatic one at the period end. There are no automatic retries (Dave); a later attempt is the Owner pressing "Retry payment".
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "attempt_started_at" TIMESTAMPTZ(3),
    -- The PaymentIntent of the latest attempt. Only a verified webhook for it decides the outcome (AGENTS.md rule 7).
    "stripe_payment_intent_id" TEXT,
    -- Why the renewal is not paid: no_card, reduction_blocked, card_declined, authentication_required, charge_refused, charge_unconfirmed, or another Stripe code.
    "failure_code" TEXT,
    -- Past due since (the FIRST failure; later failures keep it) and the end of the grace period (failed_at + the configured days, fixed at that moment).
    "failed_at" TIMESTAMPTZ(3),
    "grace_ends_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "next_period_id" UUID,
    "review_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "renewals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "renewals_frozen_amount" CHECK ("amount_cents" IS NULL OR "amount_cents" > 0),
    CONSTRAINT "renewals_frozen_seats" CHECK ("result_seats" IS NULL OR ("result_seats" >= 1 AND ("result_plan" <> 'starter' OR "result_seats" <= 5))),
    CONSTRAINT "renewals_attempts" CHECK ("attempt_count" >= 0),
    CONSTRAINT "renewals_charging_is_frozen" CHECK ("status" <> 'charging' OR ("amount_cents" IS NOT NULL AND "result_plan" IS NOT NULL AND "result_seats" IS NOT NULL AND "base_version" IS NOT NULL AND "attempt_count" >= 1)),
    CONSTRAINT "renewals_past_due_has_cause" CHECK ("status" <> 'past_due' OR ("failure_code" IS NOT NULL AND "failed_at" IS NOT NULL AND "grace_ends_at" IS NOT NULL AND "grace_ends_at" > "failed_at")),
    CONSTRAINT "renewals_paid_is_complete" CHECK ("status" <> 'paid' OR ("paid_at" IS NOT NULL AND "stripe_payment_intent_id" IS NOT NULL AND "next_period_id" IS NOT NULL AND "amount_cents" IS NOT NULL)),
    CONSTRAINT "renewals_review_has_reason" CHECK ("status" <> 'needs_review' OR "review_reason" IS NOT NULL)
);

-- One renewal per team per period: the stable key everything else hangs from (money.md).
CREATE UNIQUE INDEX "renewals_team_id_period_id_key" ON "renewals"("team_id", "period_id");
CREATE UNIQUE INDEX "renewals_stripe_payment_intent_id_key" ON "renewals"("stripe_payment_intent_id");

ALTER TABLE "renewals" ADD CONSTRAINT "renewals_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "billing_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
