import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIX = "petri_";
/** Characters of the key shown in listings, including "petri_". */
const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 6;

/** A new random key: "petri_" followed by 256 bits, base64url-encoded. */
export function generateApiKey() {
	const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
	return {
		key,
		prefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
		hash: hashApiKey(key),
	};
}

/**
 * SHA-256 is enough here: keys are 256-bit random values, so there is
 * nothing to brute-force, unlike passwords.
 */
export function hashApiKey(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

export function looksLikeApiKey(value: string): boolean {
	return value.startsWith(KEY_PREFIX);
}
