const MAX_LENGTH = 63;

/**
 * Derives a DNS-label slug from a display name: "Dashboard Concept!" →
 * "dashboard-concept". Returns "" if nothing usable remains.
 */
export function slugify(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_LENGTH)
		.replace(/-+$/, "");
}
