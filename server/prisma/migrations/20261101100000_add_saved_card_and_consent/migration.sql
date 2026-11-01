-- Saved card and consent (ADR 0030, payments slice P6a; money.md "Renewals and failed renewals"). The same migration runs on BOTH shards (data.md).
-- Purely additive: two new tables and one nullable column. No existing row is touched, and nothing here moves money or changes the ledger.
--
-- We never see or store a card number. Stripe holds the card; we keep Stripe's ids (a Customer and a PaymentMethod) and the display fields Stripe returns
-- (brand, last four digits, expiry), plus the consent the Owner gave: the exact wording shown, when, and which amount and day it named.
-- There is deliberately NO foreign key to "teams" (a team's money history outlives the team row, ADR 0026).

-- 1. The wording an activation's Checkout page showed, frozen with the operation so a retry sends identical Checkout parameters (Stripe refuses a reused
--    idempotency key with different parameters) and so the consent we store is the consent that was displayed. NULL for a paid change (no card is saved).
ALTER TABLE "payment_operations" ADD COLUMN "consent_wording" TEXT;

-- 2. A "save a card" attempt (Stripe Checkout in setup mode: nothing is charged). It mirrors payment_operations: frozen before Stripe is called, closed only
--    by a verified webhook, one open per team. A card saved during activation has no row here: its operation carries the consent_wording instead.
CREATE TYPE "card_setup_status" AS ENUM ('open', 'completed', 'expired', 'failed', 'needs_review');

CREATE TABLE "card_setups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    -- The consent as shown on Stripe's page and in the app: the amount and the day it names are frozen here (integer cents; day 1 to 31, a UTC calendar day).
    "consent_wording" TEXT NOT NULL,
    "consent_amount_cents" INTEGER NOT NULL,
    "consent_anchor_day" INTEGER NOT NULL,
    "status" "card_setup_status" NOT NULL DEFAULT 'open',
    "stripe_checkout_session_id" TEXT,
    "stripe_setup_intent_id" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "review_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "card_setups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "card_setups_consent_amount" CHECK ("consent_amount_cents" > 0),
    CONSTRAINT "card_setups_consent_day" CHECK ("consent_anchor_day" BETWEEN 1 AND 31),
    CONSTRAINT "card_setups_completed_has_intent" CHECK ("status" <> 'completed' OR ("stripe_setup_intent_id" IS NOT NULL AND "completed_at" IS NOT NULL)),
    CONSTRAINT "card_setups_review_has_reason" CHECK ("status" <> 'needs_review' OR "review_reason" IS NOT NULL)
);

CREATE UNIQUE INDEX "card_setups_stripe_checkout_session_id_key" ON "card_setups"("stripe_checkout_session_id");
CREATE UNIQUE INDEX "card_setups_stripe_setup_intent_id_key" ON "card_setups"("stripe_setup_intent_id");
CREATE INDEX "card_setups_team_id_created_at_idx" ON "card_setups"("team_id", "created_at" DESC);
-- One open setup per team: while one is open, starting another is refused (409).
CREATE UNIQUE INDEX "card_setups_one_open_per_team" ON "card_setups"("team_id") WHERE "status" = 'open';

-- 3. The team's saved cards. At most one is active; a newer card marks the older one 'replaced', and removing the card marks it 'removed'. Rows are never
--    deleted: they are the record of who authorised which card, and when. Status is the only column that ever changes after the insert.
CREATE TYPE "saved_card_status" AS ENUM ('active', 'replaced', 'removed');
CREATE TYPE "saved_card_source" AS ENUM ('activation', 'card_setup');

CREATE TABLE "team_payment_methods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "stripe_customer_id" TEXT NOT NULL,
    "stripe_payment_method_id" TEXT NOT NULL,
    -- Display fields Stripe returns for a card. Not secret, and not enough to charge anything.
    "card_brand" TEXT NOT NULL,
    "card_last4" TEXT NOT NULL,
    "card_exp_month" INTEGER NOT NULL,
    "card_exp_year" INTEGER NOT NULL,
    "source" "saved_card_source" NOT NULL,
    -- The operation or the setup that saved it (no foreign key: two different tables).
    "source_id" UUID NOT NULL,
    -- The consent, as displayed.
    "consent_wording" TEXT NOT NULL,
    "consent_amount_cents" INTEGER NOT NULL,
    "consent_anchor_day" INTEGER NOT NULL,
    "consented_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "saved_card_status" NOT NULL DEFAULT 'active',
    "replaced_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "team_payment_methods_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "team_payment_methods_last4" CHECK ("card_last4" ~ '^[0-9]{4}$'),
    CONSTRAINT "team_payment_methods_expiry" CHECK ("card_exp_month" BETWEEN 1 AND 12 AND "card_exp_year" BETWEEN 2000 AND 2200),
    CONSTRAINT "team_payment_methods_consent_amount" CHECK ("consent_amount_cents" > 0),
    CONSTRAINT "team_payment_methods_consent_day" CHECK ("consent_anchor_day" BETWEEN 1 AND 31),
    CONSTRAINT "team_payment_methods_status_times" CHECK (
        ("status" = 'active' AND "replaced_at" IS NULL AND "removed_at" IS NULL)
        OR ("status" = 'replaced' AND "replaced_at" IS NOT NULL)
        OR ("status" = 'removed' AND "removed_at" IS NOT NULL)
    )
);

-- The same Stripe card is never saved twice, so a replayed event cannot write a second row.
CREATE UNIQUE INDEX "team_payment_methods_stripe_payment_method_id_key" ON "team_payment_methods"("stripe_payment_method_id");
CREATE INDEX "team_payment_methods_team_id_created_at_idx" ON "team_payment_methods"("team_id", "created_at" DESC);
-- One active card per team.
CREATE UNIQUE INDEX "team_payment_methods_one_active_per_team" ON "team_payment_methods"("team_id") WHERE "status" = 'active';
