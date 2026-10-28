-- Billing foundation (ADR 0026; money.md). The same migration runs on BOTH shards (data.md): the team tables are used on the team's shard,
-- stripe_events only on shard A. Integer cents everywhere (never a float); currency is always 'usd'. Test mode only: "This integration uses Stripe
-- test mode only. Live-payment eligibility has not been verified."
--
-- There is deliberately NO foreign key from any billing table to "teams": a team's money history must outlive the team row, and the ledger can
-- never be deleted. Billing tables reference each other only where a row is meaningless without the other (a period).

-- CreateEnum
CREATE TYPE "billing_plan" AS ENUM ('starter', 'team', 'business');
CREATE TYPE "ledger_entry_type" AS ENUM ('period_start', 'entitlement_change', 'charge', 'credit', 'refund', 'correction');
CREATE TYPE "payment_operation_kind" AS ENUM ('activation', 'change');
CREATE TYPE "payment_operation_status" AS ENUM ('open', 'completed', 'expired', 'failed', 'needs_review');

-- CreateTable
-- One billing period of one team: [starts_on, ends_on) in UTC calendar days, calendar-month anniversaries from the activation day (money.md).
-- period_days is 28 to 31 and is the length every calculation reads; no code uses a literal 30.
CREATE TABLE "billing_periods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "period_days" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "billing_periods_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_periods_length" CHECK ("period_days" BETWEEN 28 AND 31 AND ("ends_on" - "starts_on") = "period_days")
);

CREATE UNIQUE INDEX "billing_periods_team_id_starts_on_key" ON "billing_periods"("team_id", "starts_on");

-- CreateTable
-- The current state of a team's subscription: a PROJECTION of the ledger, never its source. A team with no row has not activated and works within
-- Starter's limits. `paid_basis_cents` is what the current period has been paid at (not necessarily the entitlements' amount: a cheaper upgrade leaves
-- it higher). `version` counts the operations that changed the subscription (1 on activation); a payment applies only against its base version.
CREATE TABLE "subscriptions" (
    "team_id" UUID NOT NULL,
    "plan" "billing_plan" NOT NULL,
    "seats" INTEGER NOT NULL,
    "billing_anchor_day" INTEGER NOT NULL,
    "paid_basis_cents" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "current_period_id" UUID NOT NULL,
    "activated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("team_id"),
    CONSTRAINT "subscriptions_seats_positive" CHECK ("seats" >= 1),
    -- Starter never exceeds the seats it includes (money.md); the other plans have no ceiling.
    CONSTRAINT "subscriptions_starter_seats" CHECK ("plan" <> 'starter' OR "seats" <= 5),
    CONSTRAINT "subscriptions_anchor_day" CHECK ("billing_anchor_day" BETWEEN 1 AND 31),
    CONSTRAINT "subscriptions_paid_basis_not_negative" CHECK ("paid_basis_cents" >= 0),
    CONSTRAINT "subscriptions_version_positive" CHECK ("version" >= 1)
);

-- CreateTable
-- A paid change, frozen (money.md): what it is based on, what it will apply, what it costs. Stripe metadata carries team_id and this id. The rows are
-- updated only through status changes; the amounts never change after creation (the ledger, not this row, is the record of money).
CREATE TABLE "payment_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "kind" "payment_operation_kind" NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    -- The subscription version this was quoted against; 0 for an activation (there is no subscription yet). Applying it requires an exact match.
    "base_version" INTEGER NOT NULL,
    -- The period the change is priced in. NULL for an activation: its first period is created when the payment applies, from activation_date.
    "period_id" UUID,
    "activation_date" DATE,
    "from_plan" "billing_plan",
    "from_seats" INTEGER,
    -- What applies once the payment is verified.
    "apply_plan" "billing_plan" NOT NULL,
    "apply_seats" INTEGER NOT NULL,
    -- What was asked for but waits for the end of the period (the decreasing part of a mixed change), or NULL.
    "scheduled_plan" "billing_plan",
    "scheduled_seats" INTEGER,
    -- The calculation, frozen (the same fields as the quote the server showed).
    "period_days" INTEGER NOT NULL,
    "remaining_days" INTEGER NOT NULL,
    "paid_basis_before_cents" INTEGER NOT NULL,
    "gross_charge_cents" INTEGER NOT NULL,
    "credit_cents" INTEGER NOT NULL,
    -- gross - credit: the amount Stripe is asked to collect.
    "quote_cents" INTEGER NOT NULL,
    "paid_basis_after_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" "payment_operation_status" NOT NULL DEFAULT 'open',
    "stripe_checkout_session_id" TEXT,
    -- Unique across operations: a payment applies to exactly one operation (money.md).
    "stripe_payment_intent_id" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "review_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "payment_operations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_operations_currency" CHECK ("currency" = 'usd'),
    CONSTRAINT "payment_operations_amounts" CHECK ("quote_cents" > 0 AND "gross_charge_cents" >= 0 AND "credit_cents" >= 0 AND "quote_cents" = "gross_charge_cents" - "credit_cents" AND "paid_basis_before_cents" >= 0 AND "paid_basis_after_cents" >= 0),
    CONSTRAINT "payment_operations_period_days" CHECK ("period_days" BETWEEN 28 AND 31 AND "remaining_days" BETWEEN 1 AND "period_days"),
    CONSTRAINT "payment_operations_seats" CHECK ("apply_seats" >= 1 AND ("apply_plan" <> 'starter' OR "apply_seats" <= 5) AND ("from_seats" IS NULL OR "from_seats" >= 1)),
    -- A scheduled change has both its plan and its seats, or neither.
    CONSTRAINT "payment_operations_scheduled_pair" CHECK (("scheduled_plan" IS NULL) = ("scheduled_seats" IS NULL) AND ("scheduled_seats" IS NULL OR ("scheduled_seats" >= 1 AND ("scheduled_plan" <> 'starter' OR "scheduled_seats" <= 5)))),
    -- An activation starts from nothing and has no period yet; a change starts from the current entitlements and a period.
    CONSTRAINT "payment_operations_kind_shape" CHECK (
        ("kind" = 'activation' AND "base_version" = 0 AND "activation_date" IS NOT NULL AND "period_id" IS NULL AND "from_plan" IS NULL AND "from_seats" IS NULL)
        OR ("kind" = 'change' AND "base_version" >= 1 AND "activation_date" IS NULL AND "period_id" IS NOT NULL AND "from_plan" IS NOT NULL AND "from_seats" IS NOT NULL)
    ),
    -- A completed operation records the payment that completed it.
    CONSTRAINT "payment_operations_completed_has_payment" CHECK ("status" <> 'completed' OR ("stripe_payment_intent_id" IS NOT NULL AND "completed_at" IS NOT NULL)),
    CONSTRAINT "payment_operations_review_has_reason" CHECK ("status" <> 'needs_review' OR "review_reason" IS NOT NULL)
);

CREATE UNIQUE INDEX "payment_operations_stripe_checkout_session_id_key" ON "payment_operations"("stripe_checkout_session_id");
CREATE UNIQUE INDEX "payment_operations_stripe_payment_intent_id_key" ON "payment_operations"("stripe_payment_intent_id");
CREATE INDEX "payment_operations_team_id_created_at_idx" ON "payment_operations"("team_id", "created_at" DESC);
-- One open paid operation per team (money.md): while one is open, every other subscription change is refused (409).
CREATE UNIQUE INDEX "payment_operations_one_open_per_team" ON "payment_operations"("team_id") WHERE "status" = 'open';

-- CreateTable
-- The app's Idempotency-Key for creating a payment session, with a fingerprint of the request and the stored answer. The same key with the same
-- request returns the stored answer; the same key with a different request is refused (422).
CREATE TABLE "payment_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "operation_id" UUID,
    "response_status" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_requests_team_id_idempotency_key_key" ON "payment_requests"("team_id", "idempotency_key");

-- CreateTable
-- THE LEDGER. Append-only (AGENTS.md rule 8): the triggers below reject UPDATE, DELETE and TRUNCATE; a mistake is fixed by a new row (a correction).
-- It records money (charge, credit, refund, correction) AND every period start and plan or seat change, so a team's subscription can be rebuilt
-- from these rows alone. Amounts are signed cents. `position` is the order rows were written in (one team's changes are serialised by the
-- subscription row lock, so position order is their order).
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "position" BIGINT GENERATED ALWAYS AS IDENTITY,
    "team_id" UUID NOT NULL,
    -- The business operation: a payment operation's id for a paid change, a fresh id for a change that needs no payment.
    "operation_id" UUID NOT NULL,
    "entry_type" "ledger_entry_type" NOT NULL,
    -- Ordinal among rows of the same type in one operation, from 1. (operation_id, entry_type, sequence) is unique, so a payment applied twice
    -- writes nothing the second time.
    "sequence" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "period_id" UUID,
    -- State rows (period_start, entitlement_change) carry the state after the entry; money rows carry none.
    "plan" "billing_plan",
    "seats" INTEGER,
    "paid_basis_after_cents" INTEGER,
    "stripe_payment_intent_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ledger_entries_currency" CHECK ("currency" = 'usd'),
    CONSTRAINT "ledger_entries_sequence_positive" CHECK ("sequence" >= 1),
    CONSTRAINT "ledger_entries_amount_sign" CHECK (
        ("entry_type" = 'charge' AND "amount_cents" > 0)
        OR ("entry_type" IN ('credit', 'refund') AND "amount_cents" < 0)
        OR ("entry_type" = 'correction' AND "amount_cents" <> 0)
        OR ("entry_type" IN ('period_start', 'entitlement_change') AND "amount_cents" = 0)
    ),
    CONSTRAINT "ledger_entries_state_shape" CHECK (
        ("entry_type" IN ('period_start', 'entitlement_change') AND "plan" IS NOT NULL AND "seats" IS NOT NULL AND "paid_basis_after_cents" IS NOT NULL AND "seats" >= 1 AND "paid_basis_after_cents" >= 0 AND ("plan" <> 'starter' OR "seats" <= 5))
        OR ("entry_type" NOT IN ('period_start', 'entitlement_change') AND "plan" IS NULL AND "seats" IS NULL AND "paid_basis_after_cents" IS NULL)
    ),
    CONSTRAINT "ledger_entries_period_start_has_period" CHECK ("entry_type" <> 'period_start' OR "period_id" IS NOT NULL)
);

CREATE UNIQUE INDEX "ledger_entries_position_key" ON "ledger_entries"("position");
CREATE UNIQUE INDEX "ledger_entries_operation_id_entry_type_sequence_key" ON "ledger_entries"("operation_id", "entry_type", "sequence");
CREATE INDEX "ledger_entries_team_id_position_idx" ON "ledger_entries"("team_id", "position");

-- Append-only, enforced by the database. A row trigger rejects UPDATE and DELETE; a statement trigger rejects TRUNCATE (which a row trigger never sees).
-- Limit, written down: a database owner can still DROP the trigger or the table. This stops the application, a stray query and a test.
CREATE FUNCTION "ledger_entries_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed (add a correcting row instead)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "ledger_entries_no_update_delete" BEFORE UPDATE OR DELETE ON "ledger_entries" FOR EACH ROW EXECUTE FUNCTION "ledger_entries_append_only"();
CREATE TRIGGER "ledger_entries_no_truncate" BEFORE TRUNCATE ON "ledger_entries" FOR EACH STATEMENT EXECUTE FUNCTION "ledger_entries_append_only"();

-- CreateTable
-- The webhook inbox (shard A): one row per Stripe event, unique by Stripe's event id, written BEFORE anything is queued (AGENTS.md rules 7 and 9).
-- It keeps only the fields the processing job needs, not the whole payload. `processed_at` is set after the team-shard transaction commits.
CREATE TABLE "stripe_events" (
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "stripe_created_at" TIMESTAMPTZ(3) NOT NULL,
    "checkout_session_id" TEXT,
    "payment_intent_id" TEXT,
    "team_id" UUID,
    "operation_id" UUID,
    "work_row_id" UUID,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "processed_at" TIMESTAMPTZ(3),
    -- applied | duplicate (already applied) | review (recorded, not applied) | ignored (an event we do not act on)
    "outcome" TEXT,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("event_id"),
    CONSTRAINT "stripe_events_outcome_known" CHECK ("outcome" IS NULL OR "outcome" IN ('applied', 'duplicate', 'review', 'ignored')),
    CONSTRAINT "stripe_events_processed_has_outcome" CHECK (("processed_at" IS NULL) = ("outcome" IS NULL))
);

CREATE INDEX "stripe_events_payment_intent_id_idx" ON "stripe_events"("payment_intent_id");
-- Reconciliation looks for events that were received but never processed.
CREATE INDEX "stripe_events_unprocessed_idx" ON "stripe_events"("received_at") WHERE "processed_at" IS NULL;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_current_period_id_fkey" FOREIGN KEY ("current_period_id") REFERENCES "billing_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "billing_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "billing_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- work_rows exists on every shard, so this foreign key is allowed (the inbox is used on shard A).
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_work_row_id_fkey" FOREIGN KEY ("work_row_id") REFERENCES "work_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;
