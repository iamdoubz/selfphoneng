ALTER TABLE "moh_classes" ADD COLUMN "shuffle" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sound_files" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Existing music on hold keeps the order it was uploaded in (owner, 2026-10-21).
UPDATE "sound_files" s SET "position" = o.n FROM (
  SELECT "id", row_number() OVER (PARTITION BY "moh_class_id" ORDER BY "created_at", "id") - 1 AS n
  FROM "sound_files" WHERE "moh_class_id" IS NOT NULL
) o WHERE s."id" = o."id";
