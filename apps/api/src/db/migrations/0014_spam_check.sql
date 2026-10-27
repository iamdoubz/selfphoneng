CREATE TABLE "ftc_complaints" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"subject" text,
	"robocall" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spam_lookups" (
	"number" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"risk" text NOT NULL,
	"info" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spam_lookups_risk_check" CHECK ("spam_lookups"."risk" in ('low', 'medium', 'high'))
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "spam_risk" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "spam_info" jsonb;--> statement-breakpoint
CREATE INDEX "ftc_complaints_number_index" ON "ftc_complaints" USING btree ("number");--> statement-breakpoint
CREATE INDEX "ftc_complaints_reported_at_index" ON "ftc_complaints" USING btree ("reported_at");--> statement-breakpoint
CREATE INDEX "spam_lookups_expires_at_index" ON "spam_lookups" USING btree ("expires_at");