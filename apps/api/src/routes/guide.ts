import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { renderGuide } from "../guide.ts";

/** How to use petri., for coding assistants (also served as /llms.txt). */
export const guideRoutes: FastifyPluginAsyncZod<{
	publicUrl: string;
	previewBaseUrl: string;
}> = async (app, options) => {
	// The addresses don't change while the API runs.
	const guide = renderGuide(options);

	app.get(
		"/guide",
		{
			config: { access: "public" },
			schema: {
				tags: ["system"],
				summary: "A guide for coding assistants",
				description:
					"Markdown: how to get access, grow a culture and follow it. Start here.",
				security: [],
				response: {
					200: z.string().meta({ description: "The guide (text/markdown)" }),
				},
			},
		},
		async (_request, reply) =>
			reply.header("content-type", "text/markdown; charset=utf-8").send(guide),
	);
};
