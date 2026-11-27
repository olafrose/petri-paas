import type { BuildSummary } from "@petri/contracts";
import { DateStamp, Label } from "../../../../components/notebook/index.tsx";
import styles from "../../dashboard.module.css";

const RESULT: Record<BuildSummary["status"], string> = {
	queued: "waiting",
	running: "growing",
	succeeded: "succeeded",
	failed: "failed",
	cancelled: "cancelled",
};

const PROVIDER: Record<NonNullable<BuildSummary["provider"]>, string> = {
	dockerfile: "Dockerfile",
	buildpack: "buildpacks",
};

/** Every build of the culture, newest first: what it built and how it went. */
export function BuildHistory({ builds }: { builds: BuildSummary[] }) {
	if (builds.length === 0) {
		return <p className={styles.soft}>No build yet.</p>;
	}
	return (
		<ul className={styles.builds}>
			{builds.map((build) => (
				<li key={build.id} className={styles.build}>
					<span className={styles.soft}>
						<DateStamp date={build.createdAt} /> {build.createdAt.slice(11, 16)}{" "}
						UTC
					</span>
					<span>
						{build.ref && <code>{build.ref}</code>}
						{build.commit && (
							<>
								{" "}
								· commit <code>{build.commit.slice(0, 10)}</code>
							</>
						)}
						{!build.ref && "archive"}
						{build.provider && ` · ${PROVIDER[build.provider]}`}
					</span>
					<span>
						<Label>{RESULT[build.status]}</Label>
						{build.errorMessage && (
							<span className={styles.error}> {build.errorMessage}</span>
						)}
					</span>
				</li>
			))}
		</ul>
	);
}
