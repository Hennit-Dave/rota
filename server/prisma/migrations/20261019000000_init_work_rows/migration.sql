-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "work_status" AS ENUM ('pending', 'claimed', 'done', 'failed');

-- CreateTable
CREATE TABLE "work_rows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "status" "work_status" NOT NULL DEFAULT 'pending',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "execution_attempts" INTEGER NOT NULL DEFAULT 0,
    "run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claim_token" UUID,
    "claim_expires_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "payload" JSONB,
    "first_attempt_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "provider_message_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_rows_status_available_at_idx" ON "work_rows"("status", "available_at");

-- CreateIndex
CREATE INDEX "work_rows_status_claim_expires_at_idx" ON "work_rows"("status", "claim_expires_at");

