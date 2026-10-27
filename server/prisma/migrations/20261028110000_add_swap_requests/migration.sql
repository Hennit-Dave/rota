-- CreateEnum
CREATE TYPE "swap_status" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- CreateTable
CREATE TABLE "swap_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "requester_user_id" UUID NOT NULL,
    "counterparty_user_id" UUID NOT NULL,
    "offered_shift_id" UUID NOT NULL,
    "requested_shift_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "swap_status" NOT NULL DEFAULT 'pending',
    "snapshot" JSONB NOT NULL,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "swap_requests_pkey" PRIMARY KEY ("id"),
    -- Hand-written: Prisma cannot express a CHECK. Two different shifts and two different people.
    CONSTRAINT "swap_requests_different_shifts" CHECK ("offered_shift_id" <> "requested_shift_id"),
    CONSTRAINT "swap_requests_different_people" CHECK ("requester_user_id" <> "counterparty_user_id")
);

-- CreateIndex
-- One request per (team, requester, key): the idempotency guarantee, enforced by the database, so two simultaneous retries cannot both insert.
CREATE UNIQUE INDEX "swap_requests_team_requester_key_key" ON "swap_requests"("team_id", "requester_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "swap_requests_team_status_created_idx" ON "swap_requests"("team_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "swap_requests_team_requester_status_idx" ON "swap_requests"("team_id", "requester_user_id", "status");

-- AddForeignKey
ALTER TABLE "swap_requests" ADD CONSTRAINT "swap_requests_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
