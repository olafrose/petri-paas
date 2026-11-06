import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { Database } from "@petri/database";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
	jsonSchemaTransform,
	jsonSchemaTransformObject,
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { registerErrorHandling } from "./errors.ts";
import { healthRoutes } from "./routes/health.ts";
import { projectRoutes } from "./routes/projects.ts";

export interface AppOptions {
	db: Database;
	logger?: FastifyServerOptions["logger"];
}

/** Builds the API without starting it, so tests can use `app.inject`. */
export async function buildApp({ db, logger = false }: AppOptions) {
	const app = Fastify({ logger }).withTypeProvider<ZodTypeProvider>();

	// Requests are validated and responses serialized with the Zod schemas
	// from @petri/contracts, which also produce the OpenAPI document.
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	registerErrorHandling(app);

	await app.register(swagger, {
		openapi: {
			info: {
				title: "petri. API",
				version: "0.1.0",
				license: { name: "AGPL-3.0-or-later" },
			},
		},
		transform: jsonSchemaTransform,
		transformObject: jsonSchemaTransformObject,
	});
	// UI at /api/v1/docs, document at /api/v1/docs/json.
	await app.register(swaggerUi, { routePrefix: "/api/v1/docs" });

	await app.register(healthRoutes, { prefix: "/api/v1", db });
	await app.register(projectRoutes, { prefix: "/api/v1", db });

	return app;
}
