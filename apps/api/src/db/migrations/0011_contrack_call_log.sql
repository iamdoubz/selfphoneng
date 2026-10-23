CREATE TABLE "contrack_call_log" (
	"call_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"interaction_id" text,
	"error" text,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contrack_call_log_call_id_user_id_pk" PRIMARY KEY("call_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "contrack_log_calls" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "contrack_log_summaries" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "contrack_log_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contrack_call_log" ADD CONSTRAINT "contrack_call_log_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contrack_call_log" ADD CONSTRAINT "contrack_call_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- People already connected (C3) start logging now, not with the last 2 days of calls.
UPDATE "users" SET "contrack_log_since" = now() WHERE "contrack_token_enc" IS NOT NULL;