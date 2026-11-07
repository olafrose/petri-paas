import { type GalleryItem, gallery } from "@petri/contracts";
import { type Database, deployments, projects } from "@petri/database";
import { previewUrl } from "@petri/deployment-core";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/**
 * The public gallery: public projects whose featured deployment is ready.
 * No authentication; returns only the fields in `galleryItem`.
 */
export const galleryRoutes: FastifyPluginAsyncZod<{
	db: Database;
	previewBaseUrl: string;
}> = async (app, { db, previewBaseUrl }) => {
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
		async () => {
			const rows = await db
				.select({
					slug: projects.slug,
					name: projects.name,
					description: projects.description,
					updatedAt: projects.updatedAt,
					deploymentName: deployments.name,
					subdomain: deployments.subdomain,
				})
				.from(projects)
				.innerJoin(
					deployments,
					eq(deployments.id, projects.featuredDeploymentId),
				)
				.where(
					and(
						eq(projects.visibility, "public"),
						eq(deployments.status, "ready"),
					),
				)
				.orderBy(desc(projects.updatedAt));

			const items: GalleryItem[] = rows.map((row) => ({
				slug: row.slug,
				name: row.name,
				description: row.description,
				updatedAt: row.updatedAt.toISOString(),
				deployment: {
					name: row.deploymentName,
					status: "ready",
					url: previewUrl(previewBaseUrl, row.subdomain),
				},
			}));
			return { items };
		},
	);
};
