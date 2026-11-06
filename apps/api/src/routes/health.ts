import type { Database } from "@petri/database";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

const healthResponse = z.object({ status: z.enum(["ok", "unavailable"]) });

/** Readiness: the API is up and can reach the database. */
export const healthRoutes: FastifyPluginAsyncZod<{ db: Database }> = async (
	app,
	{ db },
) => {
	app.get(
		"/health",
		{
			config: { access: "public" },
			schema: {
				tags: ["system"],
				summary: "Service health",
				response: { 200: healthResponse, 503: healthResponse },
			},
		},
		async (request, reply) => {
			try {
				await db.execute(sql`select 1`);
				return { status: "ok" as const };
			} catch (error) {
				request.log.warn({ err: error }, "health check: database unreachable");
				return reply.status(503).send({ status: "unavailable" });
			}
		},
	);
};
