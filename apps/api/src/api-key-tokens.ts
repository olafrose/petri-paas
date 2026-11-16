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

/**
 * An access request's poll token: as random as a key, but without the
 * key prefix, so it can't be mistaken for one.
 */
export function generatePollToken() {
	const token = randomBytes(32).toString("base64url");
	return { token, hash: hashApiKey(token) };
}

/** Consonants only: no words, nothing easily misread (RFC 8628, 6.1). */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** A short code to tell requests apart, e.g. WXYZ-BCDF (~34 bits). */
export function generateUserCode(): string {
	const chars = [...randomBytes(8)].map(
		// 256 is not a multiple of 20; the slight bias doesn't matter here.
		(byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length],
	);
	return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}
