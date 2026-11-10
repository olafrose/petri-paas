import {
	errorResponse,
	type GalleryItem,
	gallery,
	galleryItem,
} from "@petri/contracts";
import { type Database, deployments, projects } from "@petri/database";
import { previewUrl } from "@petri/deployment-core";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiError } from "../errors.ts";
import { galleryImageRef } from "../image.ts";

/**
 * The public gallery: public projects whose featured deployment is ready.
 * No authentication; returns only the fields in `galleryItem`.
 */
export const galleryRoutes: FastifyPluginAsyncZod<{
	db: Database;
	previewBaseUrl: string;
}> = async (app, { db, previewBaseUrl }) => {
	/** What the gallery shows, newest change first; one project by slug. */
	async function shown(slug?: string): Promise<GalleryItem[]> {
		const rows = await db
			.select({
				slug: projects.slug,
				name: projects.name,
				description: projects.description,
				updatedAt: projects.updatedAt,
				image: projects.image,
				deploymentName: deployments.name,
				subdomain: deployments.subdomain,
			})
			.from(projects)
			.innerJoin(deployments, eq(deployments.id, projects.featuredDeploymentId))
			.where(
				and(
					eq(projects.visibility, "public"),
					eq(deployments.status, "ready"),
					slug === undefined ? undefined : eq(projects.slug, slug),
				),
			)
			.orderBy(desc(projects.updatedAt));

		return rows.map((row) => ({
			slug: row.slug,
			name: row.name,
			description: row.description,
			updatedAt: row.updatedAt.toISOString(),
			image: row.image && galleryImageRef(row.slug, row.image),
			deployment: {
				name: row.deploymentName,
				status: "ready",
				url: previewUrl(previewBaseUrl, row.subdomain),
			},
		}));
	}

	app.get(
		"/gallery",
		{
			config: { access: "public" },
			schema: {
				tags: ["gallery"],
				summary: "Public experiments",
				security: [],
				response: { 200: gallery },
			},
		},
		async () => ({ items: await shown() }),
	);

	app.get(
		"/gallery/:slug",
		{
			config: { access: "public" },
			schema: {
				tags: ["gallery"],
				summary: "One public experiment",
				description:
					"The same as its entry in the gallery; 404 for experiments the gallery doesn't show.",
				security: [],
				params: z.object({ slug: z.string() }),
				response: { 200: galleryItem, 404: errorResponse },
			},
		},
		async (request) => {
			const [item] = await shown(request.params.slug);
			if (!item) throw new ApiError(404, "not_found", "No experiment here");
			return item;
		},
	);
};
