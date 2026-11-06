import type { ErrorResponse } from "@petri/contracts";
import type { FastifyInstance } from "fastify";
import {
	hasZodFastifySchemaValidationErrors,
	isResponseSerializationError,
} from "fastify-type-provider-zod";

/** An error with a status and code that is safe to show to clients. */
export class ApiError extends Error {
	readonly statusCode: number;
	readonly code: string;
	readonly details: ErrorResponse["error"]["details"];

	constructor(
		statusCode: number,
		code: string,
		message: string,
		details?: ErrorResponse["error"]["details"],
	) {
		super(message);
		this.name = "ApiError";
		this.statusCode = statusCode;
		this.code = code;
		this.details = details;
	}
}

function isClientError(
	error: unknown,
): error is Error & { statusCode: number } {
	if (!(error instanceof Error) || !("statusCode" in error)) return false;
	const { statusCode } = error;
	return (
		typeof statusCode === "number" && statusCode >= 400 && statusCode < 500
	);
}

/**
 * Turns every error into the `ErrorResponse` shape. Unexpected errors are
 * logged and reported as a generic 500 without internal details.
 */
export function registerErrorHandling(app: FastifyInstance) {
	app.setErrorHandler((error, request, reply) => {
		let body: ErrorResponse;
		let status: number;

		if (error instanceof ApiError) {
			status = error.statusCode;
			body = {
				error: {
					code: error.code,
					message: error.message,
					...(error.details && { details: error.details }),
				},
			};
		} else if (hasZodFastifySchemaValidationErrors(error)) {
			status = 400;
			body = {
				error: {
					code: "validation_failed",
					message: `Invalid request ${error.validationContext ?? "input"}`,
					details: error.validation.map((issue) => ({
						path: issue.instancePath.replace(/^\//, "").replaceAll("/", "."),
						message: issue.message ?? "Invalid value",
					})),
				},
			};
		} else if (!isResponseSerializationError(error) && isClientError(error)) {
			// Fastify's own client errors: malformed JSON, wrong content type, ...
			status = error.statusCode;
			body = { error: { code: "bad_request", message: error.message } };
		} else {
			request.log.error({ err: error }, "unhandled error");
			status = 500;
			body = {
				error: { code: "internal_error", message: "Internal server error" },
			};
		}

		return reply.status(status).send(body);
	});

	app.setNotFoundHandler((request, reply) => {
		const body: ErrorResponse = {
			error: {
				code: "not_found",
				message: `Route ${request.method} ${request.url} not found`,
			},
		};
		return reply.status(404).send(body);
	});
}
