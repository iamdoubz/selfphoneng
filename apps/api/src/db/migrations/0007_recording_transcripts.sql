ALTER TABLE "recordings" ADD COLUMN "transcript" jsonb;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "ai_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "ai_error" text;