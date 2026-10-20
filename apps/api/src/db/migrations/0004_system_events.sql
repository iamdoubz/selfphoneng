CREATE TABLE "system_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"severity" text NOT NULL,
	"code" text NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	CONSTRAINT "system_events_severity_check" CHECK ("system_events"."severity" in ('info', 'warning', 'error'))
);
--> statement-breakpoint
CREATE INDEX "system_events_created_at_index" ON "system_events" USING btree ("created_at");