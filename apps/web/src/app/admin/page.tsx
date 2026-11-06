import { projectList } from "@petri/contracts";
import type { Metadata } from "next";
import { apiGet } from "../../lib/api.ts";
import { requestCookie } from "../../lib/session.ts";

export const metadata: Metadata = { title: "Lab notebook" };

export default async function AdminPage() {
	const cookie = await requestCookie();
	const { items } = await apiGet("/api/v1/projects", projectList, {
		...(cookie && { cookie }),
	});

	return (
		<>
			<h1>Lab notebook</h1>
			<p>
				{items.length === 0
					? "No projects yet."
					: `${items.length} project${items.length === 1 ? "" : "s"}.`}
			</p>
		</>
	);
}
