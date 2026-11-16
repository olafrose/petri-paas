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
				Describe it now and grow cultures in it later, or just grow one: a new
				experiment name in the culture form starts an experiment too.
			</p>
			<ProjectForm />
		</>
	);
}
