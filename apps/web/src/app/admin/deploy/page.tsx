import { projectList } from "@petri/contracts";
import type { Metadata } from "next";
import { Hand } from "../../../components/notebook/index.tsx";
import { apiGet } from "../../../lib/api.ts";
import { requestCookie } from "../../../lib/session.ts";
import { DeployForm } from "./deploy-form.tsx";

export const metadata: Metadata = { title: "New deployment" };

export default async function DeployPage({
	searchParams,
}: {
	searchParams: Promise<{ project?: string }>;
}) {
	const cookie = await requestCookie();
	const { items } = await apiGet("/api/v1/projects", projectList, {
		...(cookie && { cookie }),
	});
	const { project } = await searchParams;
	return (
		<>
			<Hand as="h1">New deployment</Hand>
			<DeployForm
				projects={items.map((item) => ({ slug: item.slug, name: item.name }))}
				initialProject={project ?? ""}
			/>
		</>
	);
}
