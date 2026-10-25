CREATE TYPE "public"."identity_kind" AS ENUM('oidc', 'ldap');--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "identity_kind" NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"groups" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "user_identities_kind_subject_unique" UNIQUE("kind","subject"),
	CONSTRAINT "user_identities_userId_kind_unique" UNIQUE("user_id","kind")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "method" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "idp_refresh_enc" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "idp_id_token_enc" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "idp_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_method_check" CHECK ("sessions"."method" in ('password', 'ldap', 'oidc'));