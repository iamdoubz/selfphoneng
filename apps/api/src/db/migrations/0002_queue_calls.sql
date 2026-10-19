CREATE TYPE "public"."queue_outcome" AS ENUM('answered', 'abandoned', 'timed_out');--> statement-breakpoint
CREATE TABLE "queue_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"queue_id" uuid NOT NULL,
	"uniqueid" text NOT NULL,
	"linkedid" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" "queue_outcome",
	"wait_seconds" integer,
	"agent_extension_id" uuid
);
--> statement-breakpoint
ALTER TABLE "queue_calls" ADD CONSTRAINT "queue_calls_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_calls" ADD CONSTRAINT "queue_calls_agent_extension_id_extensions_id_fk" FOREIGN KEY ("agent_extension_id") REFERENCES "public"."extensions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queue_calls_queue_id_joined_at_index" ON "queue_calls" USING btree ("queue_id","joined_at");--> statement-breakpoint
CREATE INDEX "queue_calls_uniqueid_index" ON "queue_calls" USING btree ("uniqueid");