-- Push notifications, part 1 (ADR 0032, issue #53). The same migration runs on BOTH shards (data.md), but only shard A holds rows: device tokens and delivery
-- records belong to users, who live on shard A. Purely additive: two tables, one enum and one index. No existing row is touched.

-- One row per device that can receive push: the Expo push token the app got from Expo, owned by the signed-in user. A token is unique across the table: if the
-- same phone signs in as someone else, the registration MOVES the row to the new user (a device never gets two people's notifications). Deleting a user deletes
-- their tokens.
CREATE TABLE "device_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "expo_token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id"),
    -- The shape Expo documents: ExponentPushToken[...] (or the older ExpoPushToken[...]). Anything else is refused before it can be stored.
    CONSTRAINT "device_tokens_expo_token_shape" CHECK ("expo_token" ~ '^Expo(nent)?PushToken\[[^\]]{1,200}\]$')
);

CREATE UNIQUE INDEX "device_tokens_expo_token_key" ON "device_tokens"("expo_token");
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens"("user_id");

ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One row per (notification, device): the duplicate guard for the push job (jobs.md "Push"). `sending` is written BEFORE the call to Expo, so a crash in
-- between leaves a `sending` row, which is reclaimed and resent and logged as a possible duplicate. `sent` records Expo's ticket id; an accepted ticket does not prove
-- the phone received it. The receipt job later records what Expo reported and deletes a token Expo says is no longer registered.
CREATE TYPE "push_delivery_status" AS ENUM ('sending', 'sent', 'failed');

CREATE TABLE "push_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    -- The `push` work row this delivery belongs to (a plain id: work rows are not a table Prisma relates to).
    "work_row_id" UUID NOT NULL,
    "device_token_id" UUID NOT NULL,
    "status" "push_delivery_status" NOT NULL DEFAULT 'sending',
    "sending_started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "ticket_id" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    -- Why it failed, from Expo's ticket or receipt (for example DeviceNotRegistered, MessageTooBig); never a token, never the message.
    "error" TEXT,
    "receipt_checked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "push_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "push_deliveries_sent_has_ticket" CHECK ("status" <> 'sent' OR ("ticket_id" IS NOT NULL AND "sent_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "push_deliveries_work_row_id_device_token_id_key" ON "push_deliveries"("work_row_id", "device_token_id");
CREATE INDEX "push_deliveries_ticket_id_idx" ON "push_deliveries"("ticket_id");

ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_device_token_id_fkey" FOREIGN KEY ("device_token_id") REFERENCES "device_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One `push` work row per (event, recipient), however many times the fan-out job runs: the key is the event's id and the user's id. Without this a replayed
-- fan-out would notify the same person twice.
CREATE UNIQUE INDEX "work_rows_push_dedupe_key" ON "work_rows" (("payload"->>'dedupeKey')) WHERE "kind" = 'push';
