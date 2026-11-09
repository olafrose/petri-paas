-- Existing projects are numbered in the order they were created; new ones
-- continue from there. (drizzle-kit's version would number them in
-- whatever order the rows are stored.)
ALTER TABLE "projects" ADD COLUMN "number" integer;--> statement-breakpoint
UPDATE "projects" SET "number" = "numbered"."number"
	FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "number" FROM "projects") AS "numbered"
	WHERE "projects"."id" = "numbered"."id";--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "number" ADD GENERATED ALWAYS AS IDENTITY (sequence name "projects_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1);--> statement-breakpoint
SELECT setval('"projects_number_seq"', coalesce(max("number"), 0) + 1, false) FROM "projects";--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_number_unique" UNIQUE("number");
