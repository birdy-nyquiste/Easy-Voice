ALTER TABLE "agents" ADD COLUMN "failure_msg" jsonb;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "outcome_msg" jsonb;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "description_msg" jsonb;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN "failure_msg" jsonb;--> statement-breakpoint
ALTER TABLE "voices" ADD COLUMN "failure_msg" jsonb;