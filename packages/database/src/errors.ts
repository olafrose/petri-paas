/**
 * Whether a query failed because of the named constraint (unique, check,
 * foreign key, ...). Drizzle wraps driver errors, so the PostgreSQL error
 * is either the error itself or its `cause`.
 */
export function isConstraintViolation(
	error: unknown,
	constraint: string,
): boolean {
	const candidates = [error, (error as { cause?: unknown } | null)?.cause];
	return candidates.some(
		(candidate) =>
			typeof candidate === "object" &&
			candidate !== null &&
			(candidate as { constraint?: unknown }).constraint === constraint,
	);
}
