import { z } from "zod";
import { dnsLabel } from "./common.ts";

export const deploymentStatus = z.enum([
	"queued",
	"cloning",
	"building",
	"deploying",
	"health_check",
	"ready",
	"failed",
	"stopped",
	"expired",
	"deleting",
	"deleted",
]);

export type DeploymentStatus = z.infer<typeof deploymentStatus>;

export const deploymentAction = z.enum(["stop", "start", "redeploy", "delete"]);

export type DeploymentAction = z.infer<typeof deploymentAction>;

export const lifecycleMode = z.enum(["temporary", "permanent"]);

const directory = z
	.string()
	.max(255)
	.regex(
		/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._\-/]*$/,
		"Must be a relative path inside the source, without ..",
	)
	.meta({ description: "Subdirectory to build from" });

export const gitSource = z
	.object({
		type: z.literal("git"),
		repository: z
			.url({ protocol: /^https$/ })
			.max(500)
			.meta({ description: "HTTPS URL of a public Git repository" }),
		ref: z
			.string()
			.min(1)
			.max(255)
			.regex(/^[A-Za-z0-9._\-/]+$/, "Invalid branch, tag or commit")
			.meta({ description: "Branch, tag or commit to deploy" }),
		directory: directory.optional(),
	})
	.strict();

export const buildSettings = z
	.object({
		strategy: z.enum(["auto", "dockerfile"]).default("auto"),
		port: z
			.number()
			.int()
			.min(1)
			.max(65535)
			.optional()
			.meta({ description: "HTTP port the app listens on" }),
		args: z
			.record(
				z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
				z.string().max(1000),
			)
			.default({})
			.meta({
				description:
					"Build arguments. Stored in the image: never use for secrets.",
			}),
	})
	.strict();

/** Lifetime of a temporary deployment, in hours. */
export const TTL_HOURS = { default: 48, max: 720 } as const;

export const lifecycleSettings = z
	.discriminatedUnion("mode", [
		z
			.object({
				mode: z.literal("temporary"),
				ttlHours: z
					.number()
					.int()
					.min(1)
					.max(TTL_HOURS.max)
					.default(TTL_HOURS.default),
			})
			.strict(),
		z.object({ mode: z.literal("permanent") }).strict(),
	])
	.meta({ description: "Temporary deployments expire after ttlHours" });

export const createDeploymentBody = z
	.object({
		project: dnsLabel.meta({
			description: "Project slug. The project is created if it doesn't exist.",
		}),
		name: z
			.string()
			.trim()
			.min(1)
			.max(100)
			.optional()
			.meta({ description: "Display name. Defaults to the Git ref." }),
		subdomain: dnsLabel
			.optional()
			.meta({ description: "Preview subdomain. Generated if omitted." }),
		source: gitSource,
		build: buildSettings.default({ strategy: "auto", args: {} }),
		lifecycle: lifecycleSettings.default({
			mode: "temporary",
			ttlHours: TTL_HOURS.default,
		}),
	})
	.strict()
	.meta({ id: "CreateDeployment" });

export type CreateDeploymentBody = z.infer<typeof createDeploymentBody>;

/**
 * Settings for a ZIP upload, sent as the JSON form field `settings` next
 * to the file field `archive`.
 */
export const uploadDeploymentSettings = z
	.object({
		project: createDeploymentBody.shape.project,
		name: z
			.string()
			.trim()
			.min(1)
			.max(100)
			.optional()
			.meta({ description: 'Display name. Defaults to "upload".' }),
		subdomain: createDeploymentBody.shape.subdomain,
		directory: directory.optional(),
		build: createDeploymentBody.shape.build,
		lifecycle: createDeploymentBody.shape.lifecycle,
	})
	.strict()
	.meta({ id: "UploadDeploymentSettings" });

export type UploadDeploymentSettings = z.infer<typeof uploadDeploymentSettings>;

export const deploymentSource = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("git"),
		repository: z.string(),
		ref: z.string(),
		commit: z.string().optional(),
		directory: z.string().optional(),
	}),
	z.object({
		type: z.literal("zip"),
		uploadId: z.string(),
		directory: z.string().optional(),
	}),
]);

export const buildSummary = z.object({
	id: z.uuid(),
	status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
	commit: z.string().nullable().meta({ description: "Git commit built" }),
	startedAt: z.iso.datetime().nullable(),
	finishedAt: z.iso.datetime().nullable(),
	errorMessage: z.string().nullable(),
});

export const deployment = z
	.object({
		id: z.uuid(),
		projectId: z.uuid(),
		name: z.string(),
		subdomain: z.string(),
		url: z.url().meta({
			description:
				"The preview's address; it answers while the deployment is ready",
		}),
		status: deploymentStatus,
		source: deploymentSource,
		build: z.object({
			strategy: z.enum(["auto", "dockerfile"]),
			port: z.number().int().nullable(),
			args: z.record(z.string(), z.string()),
		}),
		lifecycleMode: lifecycleMode,
		expiresAt: z.iso.datetime().nullable(),
		latestBuild: buildSummary.nullable(),
		actions: z
			.array(deploymentAction)
			.meta({ description: "Actions possible in the current status" }),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
	})
	.meta({ id: "Deployment" });

export type Deployment = z.infer<typeof deployment>;

export const deploymentList = z
	.object({ items: z.array(deployment) })
	.meta({ id: "DeploymentList" });

export type DeploymentList = z.infer<typeof deploymentList>;

export const listDeploymentsQuery = z
	.object({
		projectId: z.uuid().optional(),
		status: deploymentStatus.optional(),
	})
	.strict();

export const deploymentEvent = z
	.object({
		id: z.number().int(),
		type: z.string(),
		message: z.string(),
		data: z.record(z.string(), z.unknown()).nullable(),
		createdAt: z.iso.datetime(),
	})
	.meta({ id: "DeploymentEvent" });

export type DeploymentEvent = z.infer<typeof deploymentEvent>;

export const deploymentEventsQuery = z
	.object({
		after: z.coerce
			.number()
			.int()
			.min(0)
			.optional()
			.meta({ description: "Only events with a larger id" }),
		limit: z.coerce.number().int().min(1).max(500).default(100),
	})
	.strict();

export const deploymentEventList = z
	.object({ items: z.array(deploymentEvent) })
	.meta({ id: "DeploymentEventList" });

export type DeploymentEventList = z.infer<typeof deploymentEventList>;
