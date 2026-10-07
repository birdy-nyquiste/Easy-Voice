ALTER TABLE "calls" ADD COLUMN "charge_waived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "provider_cost_micros" integer;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "purged_at" timestamp with time zone;