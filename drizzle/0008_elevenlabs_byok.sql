CREATE TYPE "public"."clone_provider" AS ENUM('telnyx', 'elevenlabs');--> statement-breakpoint
CREATE TABLE "elevenlabs_keys" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"key_encrypted" text NOT NULL,
	"key_hint" text NOT NULL,
	"account_id" text NOT NULL,
	"telnyx_secret_id" text NOT NULL,
	"telnyx_secret_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voices" ADD COLUMN "provider" "clone_provider" DEFAULT 'telnyx' NOT NULL;--> statement-breakpoint
ALTER TABLE "elevenlabs_keys" ADD CONSTRAINT "elevenlabs_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;