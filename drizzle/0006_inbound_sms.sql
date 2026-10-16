ALTER TYPE "public"."ledger_kind" ADD VALUE 'sms' BEFORE 'refund';--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"phone_number_id" uuid,
	"from_number" text NOT NULL,
	"to_number" text NOT NULL,
	"body" text,
	"parts" integer DEFAULT 1 NOT NULL,
	"media_count" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text NOT NULL,
	"billed_cents" integer DEFAULT 0 NOT NULL,
	"provider_cost_micros" integer,
	"received_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "messages_provider_message_id_unique" UNIQUE("provider_message_id")
);
--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN "sms_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_phone_number_id_phone_numbers_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_user_idx" ON "messages" USING btree ("user_id","received_at");