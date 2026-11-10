CREATE TABLE "queue_pauses" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"queue_id" uuid NOT NULL,
	"extension_id" uuid NOT NULL,
	"reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "queue_member_state" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "queue_pauses" ADD CONSTRAINT "queue_pauses_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_pauses" ADD CONSTRAINT "queue_pauses_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queue_pauses_extension_id_started_at_index" ON "queue_pauses" USING btree ("extension_id","started_at");