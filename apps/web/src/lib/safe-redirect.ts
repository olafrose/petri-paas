/**
 * Where to go after signing in. Only same-site paths are allowed, so a
 * crafted link like /login?next=https://evil.example cannot send the
 * owner elsewhere.
 */
export function safeRedirectPath(next: string | null | undefined): string {
	const fallback = "/admin";
	if (!next?.startsWith("/") || next.startsWith("//")) return fallback;
	// Backslashes and control characters (tabs, newlines) can make browsers
	// read a path as another host.
	const hasControlCharacter = [...next].some(
		(char) => char.charCodeAt(0) < 0x20,
	);
	if (next.includes("\\") || hasControlCharacter) return fallback;
	try {
		const url = new URL(next, "http://petri.invalid");
		if (url.origin !== "http://petri.invalid") return fallback;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return fallback;
	}
}
