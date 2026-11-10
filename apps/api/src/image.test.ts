import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ImageError, inspectImage } from "./image.ts";

/** Real images, encoded by Chromium (canvas), with known sizes. */
const fixture = (name: string) =>
	readFileSync(new URL(`../test/fixtures/images/${name}`, import.meta.url));

/** A WebP file with one chunk, as the simple formats are written. */
function webp(chunk: "VP8 " | "VP8L", payload: number[]) {
	const data = Buffer.alloc(40);
	data.write("RIFF", 0, "latin1");
	data.writeUInt32LE(32, 4);
	data.write("WEBP", 8, "latin1");
	data.write(chunk, 12, "latin1");
	data.writeUInt32LE(20, 16);
	Buffer.from(payload).copy(data, 20);
	return data;
}

describe("inspectImage", () => {
	test.each([
		["photo.png", "png", 40, 30],
		["photo.jpg", "jpeg", 41, 31],
		["lossy.webp", "webp", 42, 32],
		["lossless.webp", "webp", 43, 33],
		["alpha.webp", "webp", 44, 34],
	])("reads %s", (name, type, width, height) => {
		expect(inspectImage(fixture(name))).toEqual({ type, width, height });
	});

	test("reads simple lossy and lossless WebP headers", () => {
		// Lossy key frame: 3 frame-tag bytes, start code, 300×200.
		expect(
			inspectImage(
				webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x2c, 0x01, 0xc8, 0x00]),
			),
		).toEqual({ type: "webp", width: 300, height: 200 });
		// Lossless: signature, then 14 bits each of width-1 (299) and height-1 (199).
		const bits = 299 | (199 << 14);
		expect(
			inspectImage(
				webp("VP8L", [
					0x2f,
					bits & 0xff,
					(bits >> 8) & 0xff,
					(bits >> 16) & 0xff,
					bits >>> 24,
				]),
			),
		).toEqual({ type: "webp", width: 300, height: 200 });
	});

	test("skips JPEG fill bytes and other segments before the frame", () => {
		const jpeg = fixture("photo.jpg");
		const padded = Buffer.concat([
			jpeg.subarray(0, 2),
			Buffer.from([0xff, 0xfe, 0x00, 0x05, 0x61, 0x62, 0x63]), // a comment
			Buffer.from([0xff]), // a fill byte
			jpeg.subarray(2),
		]);
		expect(inspectImage(padded)).toMatchObject({ width: 41, height: 31 });
	});

	test.each([
		["text", Buffer.from("hello, this is not an image at all, sorry")],
		["HTML", Buffer.from("<html><script>alert(1)</script></html>".padEnd(64))],
		[
			"SVG",
			Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'.padEnd(64)),
		],
		["a GIF", Buffer.from("GIF89a".padEnd(64, "\0"))],
		["an empty file", Buffer.alloc(0)],
		["a PNG cut short", fixture("photo.png").subarray(0, 20)],
		[
			"a JPEG without a frame",
			Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0]),
		],
		["a WebP with an unknown chunk", webp("VP8 ", []).fill(0x41, 12, 16)],
	])("refuses %s", (_name, data) => {
		expect(() => inspectImage(data)).toThrow(
			new ImageError("Not a PNG, JPEG or WebP image"),
		);
	});

	test("refuses images too small or too large", () => {
		const png = (width: number, height: number) => {
			const data = Buffer.from(fixture("photo.png"));
			data.writeUInt32BE(width, 16);
			data.writeUInt32BE(height, 20);
			return data;
		};
		expect(() => inspectImage(png(8, 100))).toThrow(/at least 16 pixels/);
		expect(() => inspectImage(png(9000, 100))).toThrow(/at most 8192 pixels/);
		expect(inspectImage(png(8192, 16))).toMatchObject({ width: 8192 });
	});
});
