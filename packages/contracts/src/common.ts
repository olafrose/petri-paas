import { z } from "zod";

/** A lower-case DNS label. Matches the database constraint. */
export const dnsLabel = z
	.string()
	.regex(
		/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
		"Must be 1-63 lower-case letters, digits or hyphens, not starting or ending with a hyphen",
	);

export const idParams = z.object({
	id: z.uuid(),
});

/** Every error response has this shape. */
export const errorResponse = z
	.object({
		error: z.object({
			code: z.string().meta({
				description: "Stable, machine-readable error code",
				examples: ["validation_failed", "not_found", "conflict"],
			}),
			message: z.string().meta({ description: "Human-readable summary" }),
			details: z
				.array(
					z.object({
						path: z.string(),
						message: z.string(),
					}),
				)
				.optional()
				.meta({ description: "Per-field problems, for validation errors" }),
		}),
	})
	.meta({ id: "Error" });

export type ErrorResponse = z.infer<typeof errorResponse>;
