CREATE TABLE "mobile_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text,
	"platform" text,
	"token_prefix" text,
	"token_hash" text,
	"pair_code_hash" text,
	"pair_expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mobile_devices_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "mobile_devices_pairCodeHash_unique" UNIQUE("pair_code_hash"),
	CONSTRAINT "mobile_devices_platform_check" CHECK ("mobile_devices"."platform" in ('android', 'ios'))
);
--> statement-breakpoint
ALTER TABLE "mobile_devices" ADD CONSTRAINT "mobile_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mobile_devices_user_id_index" ON "mobile_devices" USING btree ("user_id");