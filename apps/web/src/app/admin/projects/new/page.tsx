import type { Metadata } from "next";
import { Hand } from "../../../../components/notebook/index.tsx";
import styles from "../../dashboard.module.css";
import { ProjectForm } from "../project-form.tsx";

export const metadata: Metadata = { title: "New experiment" };

export default function NewProjectPage() {
	return (
		<>
			<Hand as="h1">New experiment</Hand>
			<p className={styles.lead}>
				Describe it now and deploy to it later, or just deploy: a new project
				name in the deploy form starts an experiment too.
			</p>
			<ProjectForm />
		</>
	);
}
