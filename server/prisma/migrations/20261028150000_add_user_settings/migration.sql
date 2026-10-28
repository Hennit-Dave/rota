-- CreateTable
-- One row per user, created by the first change (GET answers the defaults below while there is no row). Every setting has its own server-stamped
-- *_updated_at (NULL = never changed): the brief's conflict rule is "the most recent change wins" (ADR 0024). Quiet hours is ONE field: enabled, start and end
-- are written together, so a start from one device and an end from another can never combine into a window nobody chose.
CREATE TABLE "user_settings" (
    "user_id" UUID NOT NULL,
    "quiet_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
    -- Wall-clock times in the user's time zone. A window that crosses midnight (22:00 to 06:00) is normal.
    "quiet_hours_start" TIME(0) NOT NULL DEFAULT '22:00',
    "quiet_hours_end" TIME(0) NOT NULL DEFAULT '06:00',
    "quiet_hours_updated_at" TIMESTAMPTZ(3),
    -- IANA name. NULL = not chosen yet: enforcement falls back to the team's time zone.
    "time_zone" TEXT,
    "time_zone_updated_at" TIMESTAMPTZ(3),
    "notify_shift_changes" BOOLEAN NOT NULL DEFAULT true,
    "notify_shift_changes_updated_at" TIMESTAMPTZ(3),
    "notify_swap_updates" BOOLEAN NOT NULL DEFAULT true,
    "notify_swap_updates_updated_at" TIMESTAMPTZ(3),
    -- Inert until payments exist.
    "notify_billing" BOOLEAN NOT NULL DEFAULT true,
    "notify_billing_updated_at" TIMESTAMPTZ(3),
    "language" TEXT NOT NULL DEFAULT 'en',
    "language_updated_at" TIMESTAMPTZ(3),
    "theme" TEXT NOT NULL DEFAULT 'system',
    "theme_updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id"),
    -- Hand-written: Prisma cannot express a CHECK.
    CONSTRAINT "user_settings_theme_known" CHECK ("theme" IN ('system', 'light', 'dark')),
    CONSTRAINT "user_settings_quiet_hours_window" CHECK ("quiet_hours_start" <> "quiet_hours_end")
);

-- AddForeignKey
-- users and user_settings are both identity data on shard A, so a real foreign key is allowed here (data.md).
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
