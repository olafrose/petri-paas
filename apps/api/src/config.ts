import { commonSchema, databaseSchema } from "@petri/config";
import { z } from "zod";

export const apiConfigSchema = commonSchema
	.extend(databaseSchema.shape)
	.extend({
		/** Defaults to loopback; set to 0.0.0.0 inside a container. */
		API_HOST: z.string().default("127.0.0.1"),
		API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
	});
