import { join } from "node:path";
import type { ImageRef } from "@petri/contracts";
import type { ProjectImage } from "@petri/database";

/*
 * Recognises preview images by their content: the format's signature and
 * the dimensions in its header. The file name and the declared content
 * type are never trusted. Images are served with the type found here.
 */

export type ImageType = "png" | "jpeg" | "webp";

export interface ImageInfo {
	type: ImageType;
	width: number;
	height: number;
}

export const IMAGE_CONTENT_TYPES: Record<ImageType, string> = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Smaller is no preview; larger only costs visitors' bandwidth. */
export const MIN_IMAGE_SIDE = 16;
export const MAX_IMAGE_SIDE = 8192;

export class ImageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ImageError";
	}
}

/** The image's type and size, or an ImageError saying what's wrong. */
export function inspectImage(data: Buffer): ImageInfo {
	const info = readPng(data) ?? readJpeg(data) ?? readWebp(data);
	if (!info) {
		throw new ImageError("Not a PNG, JPEG or WebP image");
	}
	const { width, height } = info;
	if (Math.min(width, height) < MIN_IMAGE_SIDE) {
		throw new ImageError(
			`The image is ${width}×${height}; each side must be at least ${MIN_IMAGE_SIDE} pixels`,
		);
	}
	if (Math.max(width, height) > MAX_IMAGE_SIDE) {
		throw new ImageError(
			`The image is ${width}×${height}; each side may be at most ${MAX_IMAGE_SIDE} pixels`,
		);
	}
	return info;
}

const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function readPng(data: Buffer): ImageInfo | null {
	// Signature, then the IHDR chunk: length 13, type, width, height.
	if (data.length < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE))
		return null;
	if (
		data.readUInt32BE(8) !== 13 ||
		data.toString("latin1", 12, 16) !== "IHDR"
	) {
		return null;
	}
	return {
		type: "png",
		width: data.readUInt32BE(16),
		height: data.readUInt32BE(20),
	};
}

/** Start-of-frame markers, which carry the size (not DHT, JPG, DAC). */
const JPEG_FRAME_MARKERS = new Set([
	0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readJpeg(data: Buffer): ImageInfo | null {
	if (
		data.length < 4 ||
		data[0] !== 0xff ||
		data[1] !== 0xd8 ||
		data[2] !== 0xff
	) {
		return null;
	}
	// Walk the segments up to the frame header.
	let offset = 2;
	while (offset + 4 <= data.length) {
		if (data[offset] !== 0xff) return null;
		const marker = data[offset + 1] as number;
		if (marker === 0xff) {
			offset += 1; // fill byte
			continue;
		}
		// Markers without a length.
		if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			offset += 2;
			continue;
		}
		// Image data starts before any size was given: not a valid image.
		if (marker === 0xda || marker === 0xd9) return null;
		const length = data.readUInt16BE(offset + 2);
		if (length < 2) return null;
		if (JPEG_FRAME_MARKERS.has(marker)) {
			if (offset + 9 > data.length) return null;
			return {
				type: "jpeg",
				height: data.readUInt16BE(offset + 5),
				width: data.readUInt16BE(offset + 7),
			};
		}
		offset += 2 + length;
	}
	return null;
}

function readWebp(data: Buffer): ImageInfo | null {
	if (
		data.length < 30 ||
		data.toString("latin1", 0, 4) !== "RIFF" ||
		data.toString("latin1", 8, 12) !== "WEBP"
	) {
		return null;
	}
	const chunk = data.toString("latin1", 12, 16);
	if (chunk === "VP8 ") {
		// Lossy: a key frame's start code, then 14-bit width and height.
		if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a)
			return null;
		return {
			type: "webp",
			width: data.readUInt16LE(26) & 0x3fff,
			height: data.readUInt16LE(28) & 0x3fff,
		};
	}
	if (chunk === "VP8L") {
		// Lossless: a signature byte, then width-1 and height-1 in 14 bits each.
		if (data[20] !== 0x2f) return null;
		const bits = data.readUInt32LE(21);
		return {
			type: "webp",
			width: (bits & 0x3fff) + 1,
			height: ((bits >>> 14) & 0x3fff) + 1,
		};
	}
	if (chunk === "VP8X") {
		// Extended: canvas width-1 and height-1 in 24 bits each.
		return {
			type: "webp",
			width: data.readUIntLE(24, 3) + 1,
			height: data.readUIntLE(27, 3) + 1,
		};
	}
	return null;
}

/** Where a project's image is stored. The name is the project's id only. */
export const imagePath = (uploadsDir: string, projectId: string) =>
	join(uploadsDir, "images", projectId);

/** Changes with every upload: in URLs and ETags, for caches. */
export const imageVersion = (image: ProjectImage) =>
	Date.parse(image.updatedAt);

/** The image as the admin sees it: any project, with deploy:read. */
export const projectImageRef = (
	projectId: string,
	image: ProjectImage,
): ImageRef => ({
	url: `/api/v1/projects/${projectId}/image?v=${imageVersion(image)}`,
	width: image.width,
	height: image.height,
});

/** The image as the gallery shows it: public, for shown projects only. */
export const galleryImageRef = (
	slug: string,
	image: ProjectImage,
): ImageRef => ({
	url: `/api/v1/gallery/${slug}/image?v=${imageVersion(image)}`,
	width: image.width,
	height: image.height,
});
