ALTER TABLE "elevenlabs_keys" ADD COLUMN "key_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "elevenlabs_keys" ADD COLUMN "key_invalid_at" timestamp with time zone;