import type { FastifyPluginAsync } from "fastify";
import type { Auth } from "../auth/auth.ts";
import { sendWebResponse, toWebRequest } from "../auth/bridge.ts";

/** Better Auth's endpoints (sign-in, sign-out, session, OIDC callback). */
export const authRoutes: FastifyPluginAsync<{
	auth: Auth;
	publicUrl: string;
}> = async (app, { auth, publicUrl }) => {
	app.route({
		method: ["GET", "POST"],
		url: "/auth/*",
		config: { access: "public" },
		schema: { hide: true },
		handler: async (request, reply) => {
			const response = await auth.handler(toWebRequest(request, publicUrl));
			return sendWebResponse(reply, response);
		},
	});
};
