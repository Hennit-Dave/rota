-- CreateEnum
CREATE TYPE "activity_kind" AS ENUM ('shift_created', 'shift_updated', 'shift_deleted');

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "area" TEXT,
    -- Millisecond precision on purpose: a JavaScript Date and the database then agree exactly, so a cursor built from a timestamp never loses a tie.
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "break_minutes" INTEGER,
    "note" TEXT,
    -- A user on shard A, so no foreign key (data.md). NULL = an open shift. The server checks the person is a member of this team.
    "assigned_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id"),
    -- Hand-written: Prisma cannot express a CHECK.
    CONSTRAINT "shifts_ends_after_starts" CHECK ("ends_at" > "starts_at"),
    CONSTRAINT "shifts_break_not_negative" CHECK ("break_minutes" IS NULL OR "break_minutes" >= 0)
);

-- CreateTable
CREATE TABLE "activity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID NOT NULL,
    "kind" "activity_kind" NOT NULL,
    -- No foreign key: a deleted shift's history must outlive the shift.
    "shift_id" UUID,
    "data" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shifts_team_id_starts_at_idx" ON "shifts"("team_id", "starts_at");

-- CreateIndex
CREATE INDEX "shifts_team_id_assigned_user_id_starts_at_idx" ON "shifts"("team_id", "assigned_user_id", "starts_at");

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity" ADD CONSTRAINT "activity_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
