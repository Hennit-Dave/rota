-- CreateEnum
-- An invitation is either tied to an email address (the original kind) or a link anyone holding it may use once (ADR 0025, issue #37).
CREATE TYPE "invitation_kind" AS ENUM ('email', 'link');

-- AlterTable
-- Every existing row becomes 'email' (the default) and already has an address, so both checks below hold for it. Adding a column with a constant default
-- and dropping NOT NULL change the catalog only: no table rewrite.
ALTER TABLE "invitations" ADD COLUMN "kind" "invitation_kind" NOT NULL DEFAULT 'email';
ALTER TABLE "invitations" ALTER COLUMN "email" DROP NOT NULL;

-- Hand-written: Prisma cannot express a CHECK.
-- An email invitation has an address and a link has none.
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_kind_email_match"
  CHECK (("kind" = 'email' AND "email" IS NOT NULL) OR ("kind" = 'link' AND "email" IS NULL));
-- A link is a bearer credential, so it can only grant Staff: a Manager is invited by email, where the address is the second factor (ADR 0025).
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_link_staff_only" CHECK ("kind" = 'email' OR "role" = 'staff');

-- The existing "invitations_email_normalised" CHECK and the partial unique index "invitations_one_pending_per_email" ignore NULL emails, so many links
-- can be pending at once and need no change.
