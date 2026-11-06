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
	uploadDeploymentSettings,
} from "@petri/contracts";
import type { Database } from "@petri/database";
import type { JobQueue } from "@petri/jobs";
import type { FastifyPluginAsync } from "fastify";
import { ApiError } from "../errors.ts";
import { createDeployment } from "./deployments.ts";

export interface UploadOptions {
	db: Database;
	jobs: JobQueue;
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
			const uploadId = randomUUID();
			const finalPath = uploadPath(uploadsDir, uploadId);
			const partialPath = `${finalPath}.partial`;
			let settingsJson: string | undefined;
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
					} else if (part.fieldname === "settings") {
						settingsJson = String(part.value);
					} else {
						throw badRequest(`Unexpected field "${part.fieldname}"`);
					}
				}
				if (!receivedArchive) throw badRequest('The "archive" file is missing');
				if (settingsJson === undefined) {
					throw badRequest('The "settings" field is missing');
				}

				const settings = parseSettings(settingsJson);
				try {
					await inspectZip(partialPath, zipLimits);
				} catch (error) {
					if (error instanceof SourceError) {
						throw new ApiError(400, "invalid_archive", error.message);
					}
					throw error;
				}
				await rename(partialPath, finalPath);

				const created = await createDeployment(db, jobs, {
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
				});
				return reply
					.status(201)
					.header("location", `/api/v1/deployments/${created.id}`)
					.send(created);
			} catch (error) {
				await rm(partialPath, { force: true });
				await rm(finalPath, { force: true });
				if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
					throw tooLarge(maxMb);
				}
				throw error;
			}
		},
	);
};

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
