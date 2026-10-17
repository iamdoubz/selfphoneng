CREATE TYPE "public"."call_direction" AS ENUM('inbound', 'outbound', 'internal');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('answered', 'missed', 'voicemail', 'abandoned', 'busy', 'failed');--> statement-breakpoint
CREATE TYPE "public"."outbound_class" AS ENUM('internal', 'local', 'national', 'international');--> statement-breakpoint
CREATE TYPE "public"."phone_vendor" AS ENUM('yealink', 'grandstream', 'polycom', 'generic');--> statement-breakpoint
CREATE TYPE "public"."queue_strategy" AS ENUM('ringall', 'leastrecent', 'fewestcalls', 'random', 'rrmemory', 'linear');--> statement-breakpoint
CREATE TYPE "public"."record_mode" AS ENUM('never', 'inbound', 'outbound', 'all');--> statement-breakpoint
CREATE TYPE "public"."ring_strategy" AS ENUM('ringall', 'hunt');--> statement-breakpoint
CREATE TYPE "public"."sip_transport" AS ENUM('udp', 'tcp', 'tls');--> statement-breakpoint
CREATE TYPE "public"."trunk_auth_mode" AS ENUM('registration', 'ip');--> statement-breakpoint
CREATE TYPE "public"."trunk_provider" AS ENUM('voipms', 'generic');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sound_id" uuid NOT NULL,
	"destination" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_ip" "inet",
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"summary" text NOT NULL,
	"diff" jsonb
);
--> statement-breakpoint
CREATE TABLE "blocked_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocked_numbers_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "call_extensions" (
	"call_id" uuid NOT NULL,
	"extension_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_extensions_call_id_extension_id_role_pk" PRIMARY KEY("call_id","extension_id","role"),
	CONSTRAINT "call_extensions_role_check" CHECK ("call_extensions"."role" in ('caller', 'rang', 'answered'))
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"linkedid" text NOT NULL,
	"direction" "call_direction" NOT NULL,
	"status" "call_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone NOT NULL,
	"from_number" text,
	"from_name" text,
	"to_number" text,
	"did_id" uuid,
	"answered_by_extension_id" uuid,
	"talk_seconds" integer DEFAULT 0 NOT NULL,
	"recording_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_linkedid_unique" UNIQUE("linkedid")
);
--> statement-breakpoint
CREATE TABLE "cdr" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uniqueid" text NOT NULL,
	"linkedid" text NOT NULL,
	"start_at" timestamp with time zone,
	"answer_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"duration" integer,
	"billsec" integer,
	"src" text,
	"dst" text,
	"dcontext" text,
	"clid" text,
	"channel" text,
	"dstchannel" text,
	"lastapp" text,
	"lastdata" text,
	"disposition" text,
	"accountcode" text,
	"userfield" text,
	"sp_did" text,
	"sp_direction" text,
	"sp_recording" text,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"pin_enc" text,
	"admin_pin_enc" text,
	"max_members" integer DEFAULT 20 NOT NULL,
	"record" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conferences_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"name" text NOT NULL,
	"company" text,
	"email" text,
	"numbers" jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extension_id" uuid NOT NULL,
	"mac" text NOT NULL,
	"vendor" "phone_vendor" NOT NULL,
	"model" text,
	"label" text,
	"provisioning_password_enc" text NOT NULL,
	"last_provisioned_at" timestamp with time zone,
	"last_provisioned_ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_mac_unique" UNIQUE("mac")
);
--> statement-breakpoint
CREATE TABLE "did_sms_users" (
	"did_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "did_sms_users_did_id_user_id_pk" PRIMARY KEY("did_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "dids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"trunk_id" uuid NOT NULL,
	"label" text,
	"destination" jsonb NOT NULL,
	"caller_id_name_prefix" text,
	"record_inbound" boolean DEFAULT false NOT NULL,
	"sms_enabled" boolean DEFAULT false NOT NULL,
	"e911_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dids_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "emergency_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extension_number" text NOT NULL,
	"dialed" text NOT NULL,
	"caller_id_used" text NOT NULL,
	"location" text,
	"notified" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"sip_password_enc" text NOT NULL,
	"webrtc_enabled" boolean DEFAULT true NOT NULL,
	"max_contacts" integer DEFAULT 5 NOT NULL,
	"ring_seconds" integer DEFAULT 25 NOT NULL,
	"voicemail_enabled" boolean DEFAULT true NOT NULL,
	"voicemail_pin_enc" text NOT NULL,
	"voicemail_email" boolean DEFAULT true NOT NULL,
	"voicemail_attach_audio" boolean DEFAULT true NOT NULL,
	"voicemail_delete_after_email" boolean DEFAULT false NOT NULL,
	"outbound_class" "outbound_class" DEFAULT 'national' NOT NULL,
	"outbound_caller_id_did_id" uuid,
	"emergency_caller_id_did_id" uuid,
	"emergency_location" text,
	"record_mode" "record_mode" DEFAULT 'never' NOT NULL,
	"pickup_group" text,
	"language" text DEFAULT 'en' NOT NULL,
	"moh_class" text DEFAULT 'default' NOT NULL,
	"blf_numbers" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extensions_number_unique" UNIQUE("number"),
	CONSTRAINT "extensions_userId_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "generator_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger" text NOT NULL,
	"files_changed" text[] NOT NULL,
	"commands" text[] NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"duration_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"recurring_yearly" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ivr_options" (
	"ivr_id" uuid NOT NULL,
	"digit" text NOT NULL,
	"destination" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ivr_options_ivr_id_digit_pk" PRIMARY KEY("ivr_id","digit"),
	CONSTRAINT "ivr_options_digit_check" CHECK ("ivr_options"."digit" ~ '^[0-9*#]$')
);
--> statement-breakpoint
CREATE TABLE "ivrs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"greeting_sound_id" uuid NOT NULL,
	"invalid_sound_id" uuid,
	"timeout_seconds" integer DEFAULT 5 NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"allow_direct_dial" boolean DEFAULT true NOT NULL,
	"timeout_destination" jsonb NOT NULL,
	"invalid_destination" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ivrs_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "moh_classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moh_classes_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "outbound_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"patterns" jsonb NOT NULL,
	"required_class" "outbound_class" NOT NULL,
	"trunk_ids" uuid[] NOT NULL,
	"caller_id_did_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paging_group_members" (
	"paging_group_id" uuid NOT NULL,
	"extension_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paging_group_members_paging_group_id_extension_id_pk" PRIMARY KEY("paging_group_id","extension_id")
);
--> statement-breakpoint
CREATE TABLE "paging_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"duplex" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paging_groups_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "queue_member_state" (
	"queue_id" uuid NOT NULL,
	"extension_id" uuid NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_member_state_queue_id_extension_id_pk" PRIMARY KEY("queue_id","extension_id")
);
--> statement-breakpoint
CREATE TABLE "queue_members" (
	"queue_id" uuid NOT NULL,
	"extension_id" uuid NOT NULL,
	"penalty" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_members_queue_id_extension_id_pk" PRIMARY KEY("queue_id","extension_id")
);
--> statement-breakpoint
CREATE TABLE "queues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"strategy" "queue_strategy" DEFAULT 'rrmemory' NOT NULL,
	"member_ring_seconds" integer DEFAULT 15 NOT NULL,
	"retry_seconds" integer DEFAULT 5 NOT NULL,
	"wrapup_seconds" integer DEFAULT 10 NOT NULL,
	"max_wait_seconds" integer DEFAULT 300 NOT NULL,
	"max_callers" integer DEFAULT 0 NOT NULL,
	"moh_class" text DEFAULT 'default' NOT NULL,
	"announce_position" boolean DEFAULT true NOT NULL,
	"announce_every_seconds" integer DEFAULT 60 NOT NULL,
	"join_when_no_agents" boolean DEFAULT false NOT NULL,
	"record" boolean DEFAULT false NOT NULL,
	"sla_seconds" integer DEFAULT 20 NOT NULL,
	"caller_id_name_prefix" text,
	"timeout_destination" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queues_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"linkedid" text NOT NULL,
	"file_path" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recordings_filePath_unique" UNIQUE("file_path")
);
--> statement-breakpoint
CREATE TABLE "ring_group_members" (
	"ring_group_id" uuid NOT NULL,
	"extension_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ring_group_members_ring_group_id_extension_id_pk" PRIMARY KEY("ring_group_id","extension_id")
);
--> statement-breakpoint
CREATE TABLE "ring_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"strategy" "ring_strategy" DEFAULT 'ringall' NOT NULL,
	"ring_seconds" integer DEFAULT 25 NOT NULL,
	"caller_id_name_prefix" text,
	"music_instead_of_ring" boolean DEFAULT false NOT NULL,
	"no_answer_destination" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ring_groups_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"did_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"remote_number" text NOT NULL,
	"body" text NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"provider_id" text,
	"error" text,
	"sent_by_user_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_messages_direction_check" CHECK ("sms_messages"."direction" in ('in', 'out'))
);
--> statement-breakpoint
CREATE TABLE "sound_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"moh_class_id" uuid,
	"source" text NOT NULL,
	"tts_text" text,
	"original_filename" text,
	"asterisk_name" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sound_files_asteriskName_unique" UNIQUE("asterisk_name"),
	CONSTRAINT "sound_files_kind_check" CHECK ("sound_files"."kind" in ('prompt', 'moh')),
	CONSTRAINT "sound_files_source_check" CHECK ("sound_files"."source" in ('upload', 'tts', 'phone'))
);
--> statement-breakpoint
CREATE TABLE "time_conditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"open_ranges" jsonb NOT NULL,
	"use_holidays" boolean DEFAULT true NOT NULL,
	"override_digit" smallint,
	"override_state" text,
	"open_destination" jsonb NOT NULL,
	"closed_destination" jsonb NOT NULL,
	"holiday_destination" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_conditions_overrideDigit_unique" UNIQUE("override_digit"),
	CONSTRAINT "time_conditions_override_digit_check" CHECK ("time_conditions"."override_digit" between 1 and 9),
	CONSTRAINT "time_conditions_override_state_check" CHECK ("time_conditions"."override_state" in ('open', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "trunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" "trunk_provider" DEFAULT 'voipms' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"server_host" text NOT NULL,
	"server_port" integer DEFAULT 5060 NOT NULL,
	"transport" "sip_transport" DEFAULT 'udp' NOT NULL,
	"auth_mode" "trunk_auth_mode" DEFAULT 'registration' NOT NULL,
	"username" text,
	"password_enc" text,
	"from_user" text,
	"from_domain" text,
	"codecs" text[] DEFAULT '{ulaw}' NOT NULL,
	"srtp" boolean DEFAULT false NOT NULL,
	"max_channels" integer,
	"voipms_api_username" text,
	"voipms_api_password_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trunks_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user_runtime_state" (
	"extension_id" uuid PRIMARY KEY NOT NULL,
	"dnd" boolean DEFAULT false NOT NULL,
	"cfu" text,
	"cfb" text,
	"cfna" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"totp_secret_enc" text,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "voicemail_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extension_id" uuid NOT NULL,
	"msg_id" text NOT NULL,
	"folder" text NOT NULL,
	"caller_number" text,
	"caller_name" text,
	"duration_s" integer NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"file_path" text NOT NULL,
	"emailed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voicemail_messages_msgId_unique" UNIQUE("msg_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"response_code" integer,
	"next_attempt_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"secret_enc" text NOT NULL,
	"events" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_sound_id_sound_files_id_fk" FOREIGN KEY ("sound_id") REFERENCES "public"."sound_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_extensions" ADD CONSTRAINT "call_extensions_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_extensions" ADD CONSTRAINT "call_extensions_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_did_id_dids_id_fk" FOREIGN KEY ("did_id") REFERENCES "public"."dids"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_answered_by_extension_id_extensions_id_fk" FOREIGN KEY ("answered_by_extension_id") REFERENCES "public"."extensions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "did_sms_users" ADD CONSTRAINT "did_sms_users_did_id_dids_id_fk" FOREIGN KEY ("did_id") REFERENCES "public"."dids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "did_sms_users" ADD CONSTRAINT "did_sms_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dids" ADD CONSTRAINT "dids_trunk_id_trunks_id_fk" FOREIGN KEY ("trunk_id") REFERENCES "public"."trunks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_outbound_caller_id_did_id_dids_id_fk" FOREIGN KEY ("outbound_caller_id_did_id") REFERENCES "public"."dids"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_emergency_caller_id_did_id_dids_id_fk" FOREIGN KEY ("emergency_caller_id_did_id") REFERENCES "public"."dids"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ivr_options" ADD CONSTRAINT "ivr_options_ivr_id_ivrs_id_fk" FOREIGN KEY ("ivr_id") REFERENCES "public"."ivrs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ivrs" ADD CONSTRAINT "ivrs_greeting_sound_id_sound_files_id_fk" FOREIGN KEY ("greeting_sound_id") REFERENCES "public"."sound_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ivrs" ADD CONSTRAINT "ivrs_invalid_sound_id_sound_files_id_fk" FOREIGN KEY ("invalid_sound_id") REFERENCES "public"."sound_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_routes" ADD CONSTRAINT "outbound_routes_caller_id_did_id_dids_id_fk" FOREIGN KEY ("caller_id_did_id") REFERENCES "public"."dids"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paging_group_members" ADD CONSTRAINT "paging_group_members_paging_group_id_paging_groups_id_fk" FOREIGN KEY ("paging_group_id") REFERENCES "public"."paging_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paging_group_members" ADD CONSTRAINT "paging_group_members_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_member_state" ADD CONSTRAINT "queue_member_state_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_member_state" ADD CONSTRAINT "queue_member_state_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_members" ADD CONSTRAINT "queue_members_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_members" ADD CONSTRAINT "queue_members_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ring_group_members" ADD CONSTRAINT "ring_group_members_ring_group_id_ring_groups_id_fk" FOREIGN KEY ("ring_group_id") REFERENCES "public"."ring_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ring_group_members" ADD CONSTRAINT "ring_group_members_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_did_id_dids_id_fk" FOREIGN KEY ("did_id") REFERENCES "public"."dids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sound_files" ADD CONSTRAINT "sound_files_moh_class_id_moh_classes_id_fk" FOREIGN KEY ("moh_class_id") REFERENCES "public"."moh_classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_runtime_state" ADD CONSTRAINT "user_runtime_state_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voicemail_messages" ADD CONSTRAINT "voicemail_messages_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_started_at_index" ON "calls" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cdr_linkedid_index" ON "cdr" USING btree ("linkedid");--> statement-breakpoint
CREATE INDEX "sessions_user_id_index" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sms_messages_did_id_remote_number_created_at_index" ON "sms_messages" USING btree ("did_id","remote_number","created_at" DESC NULLS LAST);