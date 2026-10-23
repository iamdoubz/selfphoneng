CREATE TABLE "contact_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_user_id" uuid,
	"to_user_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"contact" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_shares_status_check" CHECK ("contact_shares"."status" in ('pending', 'accepted', 'denied'))
);
--> statement-breakpoint
ALTER TABLE "contact_shares" ADD CONSTRAINT "contact_shares_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_shares" ADD CONSTRAINT "contact_shares_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_shares_to_user_id_index" ON "contact_shares" USING btree ("to_user_id") WHERE "contact_shares"."status" = 'pending';