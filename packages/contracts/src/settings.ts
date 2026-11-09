import { z } from "zod";

const seconds = z.number().int().positive();
const bytes = z.number().int().positive();

/**
 * How this installation is set up, read-only. Changing settings stays in
 * `.env`; the limits are the ones petri. enforces.
 */
export const settings = z
	.object({
		publicUrl: z.url().meta({ description: "The admin panel and API" }),
		previewBaseUrl: z
			.url()
			.meta({ description: "Previews are served at <subdomain>.<host>" }),
		version: z.string().meta({
			description: 'Commit the API was built from, or "development"',
		}),
		limits: z.object({
			upload: z.object({
				maxBytes: bytes.meta({ description: "ZIP archive, compressed" }),
				maxExtractedBytes: bytes,
				maxFiles: z.number().int().positive(),
			}),
			git: z.object({ timeoutSeconds: seconds, maxBytes: bytes }),
			build: z.object({ timeoutSeconds: seconds }),
			container: z.object({
				memoryBytes: bytes,
				cpus: z.number().positive(),
				processes: z.number().int().positive(),
			}),
			healthCheck: z.object({
				timeoutSeconds: seconds.meta({
					description: "How long a new app may take to answer",
				}),
			}),
			temporaryTtlHours: z.object({
				default: z.number().int().positive(),
				max: z.number().int().positive(),
			}),
		}),
	})
	.meta({ id: "Settings" });

export type Settings = z.infer<typeof settings>;
