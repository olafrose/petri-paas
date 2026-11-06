import { z } from "zod";

/**
 * A project as shown in the public gallery. Deliberately minimal: nothing
 * here may reveal private notes, sources or infrastructure details.
 */
export const galleryItem = z
	.object({
		slug: z.string(),
		name: z.string(),
		description: z.string(),
		updatedAt: z.iso.datetime(),
		deployment: z.object({
			name: z.string().meta({ description: "Branch or version shown" }),
			status: z.literal("ready"),
		}),
	})
	.meta({ id: "GalleryItem" });

export type GalleryItem = z.infer<typeof galleryItem>;

export const gallery = z
	.object({ items: z.array(galleryItem) })
	.meta({ id: "Gallery" });

export type Gallery = z.infer<typeof gallery>;
