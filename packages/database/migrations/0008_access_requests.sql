CREATE TYPE "public"."access_request_status" AS ENUM('pending', 'denied', 'granted', 'collected');--> statement-breakpoint
CREATE TABLE "access_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"reason" text,
	"scopes" text[] NOT NULL,
	"status" "access_request_status" DEFAULT 'pending' NOT NULL,
	"user_code" text NOT NULL,
	"poll_token_hash" text NOT NULL,
	"address" text NOT NULL,
	"user_agent" text,
	"key_expires_in_days" integer,
	"last_polled_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_requests_userCode_unique" UNIQUE("user_code"),
	CONSTRAINT "access_requests_pollTokenHash_unique" UNIQUE("poll_token_hash"),
	CONSTRAINT "access_requests_has_scopes" CHECK (cardinality("access_requests"."scopes") > 0)
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "access_request_id" uuid;--> statement-breakpoint
CREATE INDEX "access_requests_address_created_at_index" ON "access_requests" USING btree ("address","created_at");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_access_request_id_access_requests_id_fk" FOREIGN KEY ("access_request_id") REFERENCES "public"."access_requests"("id") ON DELETE set null ON UPDATE no action;