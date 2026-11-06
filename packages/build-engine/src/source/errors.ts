export type SourceErrorCode =
	| "invalid_url"
	| "blocked_address"
	| "dns_failed"
	| "ref_not_found"
	| "fetch_failed"
	| "too_large"
	| "timeout"
	| "cancelled";

/** A source could not be fetched. `message` is safe to show the owner. */
export class SourceError extends Error {
	readonly code: SourceErrorCode;

	constructor(code: SourceErrorCode, message: string) {
		super(message);
		this.name = "SourceError";
		this.code = code;
	}
}
