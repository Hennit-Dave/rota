-- AlterEnum
-- The feed (ADR 0022) gains three kinds of row for swaps (ADR 0023). Its own migration, apart from the table: a new enum value cannot be USED in the
-- transaction that adds it, and nothing here uses it. Existing rows are not touched.
ALTER TYPE "activity_kind" ADD VALUE 'swap_requested';
ALTER TYPE "activity_kind" ADD VALUE 'swap_approved';
ALTER TYPE "activity_kind" ADD VALUE 'swap_rejected';
