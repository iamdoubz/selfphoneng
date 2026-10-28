CREATE TABLE "spam_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"reason" text NOT NULL,
	"reported_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spam_reports_number_reportedBy_unique" UNIQUE("number","reported_by")
);
--> statement-breakpoint
ALTER TABLE "spam_reports" ADD CONSTRAINT "spam_reports_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;