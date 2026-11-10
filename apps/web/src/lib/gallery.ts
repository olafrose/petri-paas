import "server-only";
import { type GalleryItem, gallery, galleryItem } from "@petri/contracts";
import { cache } from "react";
import { ApiRequestError, apiGet } from "./api.ts";
import { publicOrigin } from "./public-url.ts";

/** The gallery, fetched once per request (page and its metadata). */
export const getGallery = cache(() => apiGet("/api/v1/gallery", gallery));

/** One experiment the gallery shows, or null. */
export const getGalleryItem = cache(async (slug: string) =>
	apiGet(`/api/v1/gallery/${encodeURIComponent(slug)}`, galleryItem).catch(
		(error: unknown) => {
			if (error instanceof ApiRequestError && error.status === 404) return null;
			throw error;
		},
	),
);

/** A link-preview image (Open Graph), absolute, or none. */
export async function previewImage(item: GalleryItem | undefined) {
	if (!item?.image) return undefined;
	const { url, width, height } = item.image;
	return [{ url: `${await publicOrigin()}${url}`, width, height }];
}
