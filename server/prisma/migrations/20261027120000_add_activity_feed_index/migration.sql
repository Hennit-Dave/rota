-- CreateIndex
-- The activity feed's query (ADR 0022): rows of one team, newest first by (created_at, id), then "strictly older than the cursor". With the order
-- spelled out here the database reads the first 21 index entries instead of every row of the team and sorting them.
CREATE INDEX "activity_team_id_created_at_id_idx" ON "activity"("team_id", "created_at" DESC, "id" DESC);
