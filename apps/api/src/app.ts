import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { Database } from "@petri/database";
import type { JobQueue } from "@petri/jobs";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
	jsonSchemaTransform,
	jsonSchemaTransformObject,
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { registerAccessControl } from "./access.ts";
import type { Auth } from "./auth/auth.ts";
import { registerErrorHandling } from "./errors.ts";
import { apiKeyRoutes } from "./routes/api-keys.ts";
import { authRoutes } from "./routes/auth.ts";
import { deploymentRoutes } from "./routes/deployments.ts";
import { galleryRoutes } from "./routes/gallery.ts";
import { healthRoutes } from "./routes/health.ts";
import { projectRoutes } from "./routes/projects.ts";

export interface AppOptions {
	db: Database;
	auth: Auth;
	/** Background jobs; the API only sends them. */
	jobs: JobQueue;
	/** Public URL of the admin panel, e.g. https://petri.example.com. */
	publicUrl: string;
	/** Reverse proxies whose X-Forwarded-For is trusted. */
	trustProxy?: string[];
	logger?: FastifyServerOptions["logger"];
}

/** Builds the API without starting it, so tests can use `app.inject`. */
export async function buildApp({
	db,
	auth,
	jobs,
	publicUrl,
	trustProxy = [],
	logger = false,
}: AppOptions) {
	const app = Fastify({
		logger,
		trustProxy: trustProxy.length > 0 ? trustProxy : false,
	}).withTypeProvider<ZodTypeProvider>();

	// Requests are validated and responses serialized with the Zod schemas
	// from @petri/contracts, which also produce the OpenAPI document.
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	registerErrorHandling(app);
	registerAccessControl(app, { db, auth, publicUrl });

	await app.register(swagger, {
		openapi: {
			info: {
				title: "petri. API",
				version: "0.1.0",
				license: { name: "AGPL-3.0-or-later" },
			},
			components: {
				securitySchemes: {
					apiKey: {
						type: "http",
						scheme: "bearer",
						description: "API key created in the admin panel (petri_…)",
					},
				},
			},
			security: [{ apiKey: [] }],
		},
		transform: jsonSchemaTransform,
		transformObject: jsonSchemaTransformObject,
	});
	// UI at /api/v1/docs, document at /api/v1/docs/json.
	await app.register(swaggerUi, { routePrefix: "/api/v1/docs" });

	const prefix = "/api/v1";
	await app.register(healthRoutes, { prefix, db });
	await app.register(authRoutes, { prefix, auth, publicUrl });
	await app.register(galleryRoutes, { prefix, db });
	await app.register(projectRoutes, { prefix, db });
	await app.register(deploymentRoutes, { prefix, db, jobs });
	await app.register(apiKeyRoutes, { prefix, db });

	return app;
}
