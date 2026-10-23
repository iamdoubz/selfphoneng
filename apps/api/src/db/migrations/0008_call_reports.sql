CREATE TYPE "public"."call_report" AS ENUM('off', 'hourly', 'daily', 'weekly');--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "call_report" "call_report" DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "call_report_time" text DEFAULT '08:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "call_report_weekday" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "call_report_summaries" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "call_report_sent_at" timestamp with time zone;