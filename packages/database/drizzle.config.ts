import { defineConfig } from "drizzle-kit";

// Used only by `pnpm db:generate` to write SQL migrations from the schema.
export default defineConfig({
	dialect: "postgresql",
	schema: ["./src/schema.ts", "./src/auth-schema.ts"],
	out: "./migrations",
	casing: "snake_case",
});
