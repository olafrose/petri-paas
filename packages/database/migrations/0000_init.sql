CREATE TYPE "public"."build_provider" AS ENUM('dockerfile', 'buildpack');--> statement-breakpoint
CREATE TYPE "public"."build_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('queued', 'cloning', 'building', 'deploying', 'health_check', 'ready', 'failed', 'stopped', 'expired', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_mode" AS ENUM('temporary', 'permanent');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_keyHash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_has_scopes" CHECK (cardinality("api_keys"."scopes") > 0)
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"status" "build_status" DEFAULT 'queued' NOT NULL,
	"provider" "build_provider",
	"image_id" text,
	"log_path" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deployment_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"deployment_id" uuid NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"subdomain" text NOT NULL,
	"source" jsonb NOT NULL,
	"status" "deployment_status" DEFAULT 'queued' NOT NULL,
	"image_id" text,
	"container_id" text,
	"route_id" text,
	"internal_port" integer,
	"lifecycle_mode" "lifecycle_mode" NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_subdomain_unique" UNIQUE("subdomain"),
	CONSTRAINT "deployments_subdomain_format" CHECK ("deployments"."subdomain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "deployments_internal_port_range" CHECK ("deployments"."internal_port" between 1 and 65535),
	CONSTRAINT "deployments_expiry_matches_lifecycle" CHECK (("deployments"."lifecycle_mode" = 'temporary') = ("deployments"."expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"visibility" "visibility" DEFAULT 'public' NOT NULL,
	"featured_deployment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "projects_slug_format" CHECK ("projects"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
);
--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_featured_deployment_id_deployments_id_fk" FOREIGN KEY ("featured_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "builds_deployment_id_index" ON "builds" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "deployment_events_deployment_id_id_index" ON "deployment_events" USING btree ("deployment_id","id");--> statement-breakpoint
CREATE INDEX "deployments_project_id_index" ON "deployments" USING btree ("project_id");