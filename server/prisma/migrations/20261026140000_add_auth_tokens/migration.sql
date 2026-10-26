-- CreateEnum
CREATE TYPE "auth_token_purpose" AS ENUM ('magic_link', 'password_reset');

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "purpose" "auth_token_purpose" NOT NULL,
    -- SHA-256 of the secret (32 bytes). The secret itself is never stored.
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    -- Set when the token is redeemed, replaced by a newer request, or killed by a successful reset.
    "used_at" TIMESTAMPTZ(6),
    -- The email work row, written in the same transaction (same database: shard A).
    "email_work_row_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_tokens_user_id_purpose_idx" ON "auth_tokens"("user_id", "purpose");

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_email_work_row_id_fkey" FOREIGN KEY ("email_work_row_id") REFERENCES "work_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;
