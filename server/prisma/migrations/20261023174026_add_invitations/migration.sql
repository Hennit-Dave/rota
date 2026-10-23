-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "team_role" NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "invited_by_user_id" UUID NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_by_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    -- The latest email work row for this invitation (a resend writes a new row and moves this). The pending list reads its state
    -- to show "queued", "sent" or "email not sent" without the app guessing.
    "email_work_row_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id"),
    -- Hand-written: nobody is invited as Owner (one Owner per team, ADR 0014). Prisma cannot express a CHECK.
    CONSTRAINT "invitations_role_not_owner" CHECK ("role" <> 'owner'),
    -- Hand-written: the database refuses an address that is not already trimmed and lowercased, so the unique index on
    -- (team_id, email) cannot be dodged by "Sofia@Example.com" vs "sofia@example.com".
    CONSTRAINT "invitations_email_normalised" CHECK ("email" = lower(btrim("email")))
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex (hand-written: Prisma cannot express a partial index). One pending invitation per team and email.
CREATE UNIQUE INDEX "invitations_one_pending_per_email" ON "invitations"("team_id", "email") WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- AddForeignKey (same database: an invitation and its team share a shard). No foreign key on the user columns: users are on shard A.
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (same database: the invitation and its work row are written in one transaction on the team's shard)
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_email_work_row_id_fkey" FOREIGN KEY ("email_work_row_id") REFERENCES "work_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: the correlation ID jobs.md requires on the work row. ADR 0002 deferred it until the first job started by a request.
ALTER TABLE "work_rows" ADD COLUMN "origin_request_id" UUID;
