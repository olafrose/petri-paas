import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Total size of the files under a directory (symlinks not followed). */
export async function diskUsage(path: string): Promise<number> {
	let total = 0;
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch {
		return 0; // vanished while measuring
	}
	for (const entry of entries) {
		const full = join(path, entry.name);
		if (entry.isDirectory()) {
			total += await diskUsage(full);
		} else {
			try {
				total += (await lstat(full)).size;
			} catch {
				// vanished while measuring
			}
		}
	}
	return total;
}
