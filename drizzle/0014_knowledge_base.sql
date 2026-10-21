CREATE TYPE "public"."knowledge_base_status" AS ENUM('ready', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."knowledge_mode" AS ENUM('off', 'reference', 'strict');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_status" AS ENUM('processing', 'ready', 'failed', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_type" AS ENUM('text', 'file', 'url');--> statement-breakpoint
ALTER TYPE "public"."ledger_kind" ADD VALUE 'knowledge_source' BEFORE 'refund';--> statement-breakpoint
CREATE TABLE "agent_knowledge" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"mode" "knowledge_mode" DEFAULT 'reference' NOT NULL,
	"bucket" text NOT NULL,
	"status" "knowledge_base_status" DEFAULT 'ready' NOT NULL,
	"embedded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"type" "knowledge_source_type" NOT NULL,
	"name" text,
	"content" text,
	"url" text,
	"crawl_task_id" text,
	"size_bytes" integer,
	"price_cents" integer NOT NULL,
	"status" "knowledge_source_status" DEFAULT 'processing' NOT NULL,
	"failure_reason" text,
	"failure_msg" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_knowledge" ADD CONSTRAINT "agent_knowledge_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge" ADD CONSTRAINT "agent_knowledge_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_sources_user_idx" ON "knowledge_sources" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_agent_idx" ON "knowledge_sources" USING btree ("agent_id");