ALTER TABLE "users" ADD COLUMN "totp_recovery_hashes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" bigint;