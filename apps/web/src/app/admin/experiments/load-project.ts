import "server-only";
import { deploymentList, project } from "@petri/contracts";
import { notFound } from "next/navigation";
import { ApiRequestError, apiGet } from "../../../lib/api.ts";
import { requestCookie } from "../../../lib/session.ts";

/** A project and its deployments, for its pages; unknown ids are a 404. */
export async function loadProject(id: string) {
	const cookie = await requestCookie();
	const options = cookie ? { cookie } : {};
	const current = await apiGet(
		`/api/v1/projects/${id}`,
		project,
		options,
	).catch((error: unknown) => {
		if (error instanceof ApiRequestError && [400, 404].includes(error.status))
			notFound();
		throw error;
	});
	const { items: deployments } = await apiGet(
		`/api/v1/deployments?projectId=${current.id}`,
		deploymentList,
		options,
	);
	return { project: current, deployments };
}
