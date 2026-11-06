import { crc32, deflateRawSync } from "node:zlib";

export interface TestZipEntry {
	name: string;
	data?: Buffer | string;
	/** Unix mode including the file type, e.g. 0o100644 or 0o120777. */
	mode?: number;
	deflate?: boolean;
	/** Claim a different uncompressed size than the real one. */
	declaredSize?: number;
	encrypted?: boolean;
}

/**
 * Writes a ZIP archive byte by byte. Unlike real ZIP tools, it happily
 * produces the malicious archives the tests need.
 */
export function buildZip(entries: TestZipEntry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const raw = Buffer.from(entry.data ?? "");
		const compressed = entry.deflate ? deflateRawSync(raw) : raw;
		// Encrypted entries start with a 12-byte encryption header.
		const body = entry.encrypted
			? Buffer.concat([Buffer.alloc(12), compressed])
			: compressed;
		const method = entry.deflate ? 8 : 0;
		const flags = 0x0800 | (entry.encrypted ? 0x1 : 0); // UTF-8 names
		const crc = crc32(raw);
		const size = entry.declaredSize ?? raw.length;
		const mode = entry.mode ?? (entry.name.endsWith("/") ? 0o040755 : 0o100644);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc >>> 0, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(size, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, body);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((3 << 8) | 20, 4); // made on Unix
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(flags, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc >>> 0, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(size, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE((mode << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);

		offset += local.length + name.length + body.length;
	}

	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}
