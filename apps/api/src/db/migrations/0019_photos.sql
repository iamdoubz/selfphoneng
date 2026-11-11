CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"contact_id" uuid,
	"mime" text NOT NULL,
	"data" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photos_userId_unique" UNIQUE("user_id"),
	CONSTRAINT "photos_contactId_unique" UNIQUE("contact_id"),
	CONSTRAINT "photos_one_owner" CHECK (("photos"."user_id" is null) <> ("photos"."contact_id" is null)),
	CONSTRAINT "photos_mime" CHECK ("photos"."mime" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "photos_size" CHECK (octet_length("photos"."data") <= 262144)
);
--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;