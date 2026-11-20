import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import {
	DEFAULT_ZIP_LIMITS,
	inspectZip,
	SourceError,
	type ZipLimits,
} from "@petri/build-engine";
import {
	deployment,
	errorResponse,
	idParams,
	uploadDeploymentSettings,
} from "@petri/contracts";
import { deployments } from "@petri/database";
import { canPerform } from "@petri/deployment-core";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ApiError } from "../errors.ts";
import {
	createDeployment,
	type DeploymentDeps,
	redeployDeployment,
	redeploySource,
	sendDeployment,
} from "./deployments.ts";

export interface UploadOptions extends DeploymentDeps {
	/** Where archives are kept, so deployments can be rebuilt later. */
	uploadsDir: string;
	maxUploadBytes?: number;
	zipLimits?: ZipLimits;
}

export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Path of a stored upload. */
export function uploadPath(uploadsDir: string, uploadId: string): string {
	return join(uploadsDir, `${uploadId}.zip`);
}

export const uploadRoutes: FastifyPluginAsync<UploadOptions> = async (
	app,
	{
		db,
		jobs,
		previewBaseUrl,
		uploadsDir,
		maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
		zipLimits = DEFAULT_ZIP_LIMITS,
	},
) => {
	await mkdir(uploadsDir, { recursive: true, mode: 0o700 });
	await app.register(multipart, {
		limits: {
			fileSize: maxUploadBytes,
			// One file and one field are expected; one spare of each lets the
			// handler answer "unexpected field" instead of a generic limit error.
			files: 2,
			fields: 2,
			fieldSize: 64 * 1024,
			parts: 4,
		},
	});
	const maxMb = Math.round(maxUploadBytes / 1024 / 1024);
	const store: ArchiveStore = { uploadsDir, maxMb, zipLimits };

	app.post(
		"/deployments/upload",
		{
			config: { access: { scope: "deploy:create" } },
			schema: {
				tags: ["deployments"],
				summary: "Deploy from a ZIP archive",
				description: [
					"Multipart form with two fields:",
					`- \`archive\`: the ZIP file (at most ${maxMb} MB)`,
					"- `settings`: JSON matching UploadDeploymentSettings",
					"",
					"The archive is checked before it is accepted. A single top-level directory (as in GitHub's Download ZIP) is removed.",
				].join("\n"),
				consumes: ["multipart/form-data"],
				response: {
					201: deployment,
					400: errorResponse,
					409: errorResponse,
					413: errorResponse,
				},
			},
		},
		async (request, reply) => {
			const created = await receiveArchive(
				request,
				store,
				{ name: "settings", parse: parseSettings },
				(uploadId, settings) =>
					createDeployment(
						{ db, jobs, previewBaseUrl },
						{
							project: settings.project,
							name: settings.name ?? "upload",
							subdomain: settings.subdomain,
							source: {
								type: "zip",
								uploadId,
								...(settings.directory && { directory: settings.directory }),
							},
							build: settings.build,
							lifecycle: settings.lifecycle,
						},
					),
			);
			reply.header("location", `/api/v1/deployments/${created.id}`);
			return sendDeployment(reply, 201, created);
		},
	);

	app.post(
		"/deployments/:id/upload",
		{
			config: { access: { scope: "deploy:update" } },
			schema: {
				tags: ["deployments"],
				summary: "Build a deployment again from a new ZIP archive",
				description: [
					`Multipart form with one field, \`archive\`: the ZIP file (at most ${maxMb} MB). Checked like a first upload.`,
					"",
					"As a redeploy, with the new archive: a `ready` deployment keeps answering until the new version passes its health check. The new archive replaces the old one once its version is live; if the build fails, the old one stays. Only for deployments built from a ZIP archive; one build at a time (409).",
				].join("\n"),
				consumes: ["multipart/form-data"],
				params: idParams,
				response: {
					202: deployment,
					400: errorResponse,
					404: errorResponse,
					409: errorResponse,
					413: errorResponse,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params as { id: string };
			// Answered before the archive is read, where possible; the
			// redeploy checks again.
			const [current] = await db
				.select({ status: deployments.status, source: deployments.source })
				.from(deployments)
				.where(eq(deployments.id, id));
			if (!current)
				throw new ApiError(404, "not_found", "Deployment not found");
			redeploySource(current.source, { uploadId: "" });
			if (!canPerform("redeploy", current.status)) {
				throw new ApiError(
					409,
					"conflict",
					`A deployment that is "${current.status}" cannot be redeployed`,
				);
			}

			const result = await receiveArchive(request, store, null, (uploadId) =>
				redeployDeployment(
					{ db, jobs, previewBaseUrl },
					id,
					{ uploadId },
					request.principal,
				),
			);
			return sendDeployment(reply, 202, result);
		},
	);
};

interface ArchiveStore {
	uploadsDir: string;
	maxMb: number;
	zipLimits: ZipLimits;
}

/** A form field sent next to the archive, and how to read it. */
interface FormField<F> {
	name: string;
	parse: (value: string) => F;
}

/**
 * Receives a multipart upload: the `archive` file and, if asked for, one
 * other field (required). The field is read, the archive checked and
 * stored, then `use` gets the archive's id; if anything fails, the
 * archive is removed again.
 */
async function receiveArchive<F, T>(
	request: FastifyRequest,
	{ uploadsDir, maxMb, zipLimits }: ArchiveStore,
	formField: FormField<F> | null,
	use: (uploadId: string, field: F) => Promise<T>,
): Promise<T> {
	const uploadId = randomUUID();
	const finalPath = uploadPath(uploadsDir, uploadId);
	const partialPath = `${finalPath}.partial`;
	let fieldValue: string | undefined;
	let receivedArchive = false;

	try {
		for await (const part of request.parts()) {
			if (part.type === "file") {
				if (part.fieldname !== "archive" || receivedArchive) {
					part.file.resume();
					throw badRequest(`Unexpected file field "${part.fieldname}"`);
				}
				receivedArchive = true;
				await pipeline(
					part.file,
					createWriteStream(partialPath, { flags: "wx", mode: 0o600 }),
				);
				if (part.file.truncated) throw tooLarge(maxMb);
			} else if (formField && part.fieldname === formField.name) {
				fieldValue = String(part.value);
			} else {
				throw badRequest(`Unexpected field "${part.fieldname}"`);
			}
		}
		if (!receivedArchive) throw badRequest('The "archive" file is missing');
		let field = undefined as F;
		if (formField) {
			if (fieldValue === undefined) {
				throw badRequest(`The "${formField.name}" field is missing`);
			}
			field = formField.parse(fieldValue);
		}

		try {
			await inspectZip(partialPath, zipLimits);
		} catch (error) {
			if (error instanceof SourceError) {
				throw new ApiError(400, "invalid_archive", error.message);
			}
			throw error;
		}
		await rename(partialPath, finalPath);
		return await use(uploadId, field);
	} catch (error) {
		await rm(partialPath, { force: true });
		await rm(finalPath, { force: true });
		if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
			throw tooLarge(maxMb);
		}
		throw error;
	}
}

function parseSettings(json: string) {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw badRequest('The "settings" field is not valid JSON');
	}
	const result = uploadDeploymentSettings.safeParse(value, {
		reportInput: false,
	});
	if (!result.success) {
		throw new ApiError(
			400,
			"validation_failed",
			"Invalid upload settings",
			result.error.issues.map((issue) => ({
				path: ["settings", ...issue.path].join("."),
				message: issue.message,
			})),
		);
	}
	return result.data;
}

function badRequest(message: string): ApiError {
	return new ApiError(400, "validation_failed", message);
}

function tooLarge(maxMb: number): ApiError {
	return new ApiError(
		413,
		"too_large",
		`The archive is larger than ${maxMb} MB`,
	);
}
