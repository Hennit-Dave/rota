-- Reductions at period end (ADR 0029, payments slice P5; money.md "Reductions that leave too many members").
-- Two additive changes, the same migration on BOTH shards (data.md). No existing row is touched.
--
-- 1. memberships.deactivated_at: members are deactivated, never deleted. A deactivated member is not a seat and is not a member of the team on any
--    route (the team middleware answers 404, like a stranger). Nothing sets it yet: the reduction is APPLIED at the period boundary, which the renewal
--    slice (P6) does. P5 only schedules, validates and checks.
-- 2. scheduled_changes: a decrease the Owner scheduled for the end of the current period. It moves no money and changes no entitlement until it is
--    applied. No foreign key to teams (a team's money history outlives the team row, ADR 0026).

ALTER TABLE "memberships" ADD COLUMN "deactivated_at" TIMESTAMPTZ(3);

CREATE TYPE "scheduled_change_status" AS ENUM ('scheduled', 'cancelled', 'ready', 'blocked', 'continuing', 'applied');

CREATE TABLE "scheduled_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    -- What it was scheduled against: the period it takes effect at the end of, and the subscription's state and version at that moment.
    "from_period_id" UUID NOT NULL,
    "base_version" INTEGER NOT NULL,
    "from_plan" "billing_plan" NOT NULL,
    "from_seats" INTEGER NOT NULL,
    "target_plan" "billing_plan" NOT NULL,
    "target_seats" INTEGER NOT NULL,
    -- The end of that period: the first day of the next one (00:00 UTC).
    "effective_on" DATE NOT NULL,
    -- The members who become inactive at the boundary (never the Owner). Empty when the team already fits the target.
    "selected_member_ids" UUID[] NOT NULL DEFAULT '{}',
    -- The Owner's explicit acceptance of "continue at the current price if members still exceed the limit", with the wording shown and the time.
    "fallback_accepted_at" TIMESTAMPTZ(3),
    "fallback_wording" TEXT,
    "status" "scheduled_change_status" NOT NULL DEFAULT 'scheduled',
    -- Set by the boundary check: when it ran and what it found.
    "checked_at" TIMESTAMPTZ(3),
    "check_detail" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "scheduled_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "scheduled_changes_seats" CHECK ("from_seats" >= 1 AND "target_seats" >= 1 AND ("target_plan" <> 'starter' OR "target_seats" <= 5) AND ("from_plan" <> 'starter' OR "from_seats" <= 5)),
    CONSTRAINT "scheduled_changes_fallback_pair" CHECK (("fallback_accepted_at" IS NULL) = ("fallback_wording" IS NULL)),
    CONSTRAINT "scheduled_changes_checked_has_time" CHECK ("status" NOT IN ('ready', 'blocked', 'continuing') OR "checked_at" IS NOT NULL)
);

-- One decrease in flight per team: scheduled, or checked at the boundary and waiting to be applied.
CREATE UNIQUE INDEX "scheduled_changes_one_live_per_team" ON "scheduled_changes"("team_id") WHERE "status" IN ('scheduled', 'ready', 'blocked', 'continuing');
CREATE INDEX "scheduled_changes_team_id_created_at_idx" ON "scheduled_changes"("team_id", "created_at" DESC);

ALTER TABLE "scheduled_changes" ADD CONSTRAINT "scheduled_changes_from_period_id_fkey" FOREIGN KEY ("from_period_id") REFERENCES "billing_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
