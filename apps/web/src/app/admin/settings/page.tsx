import { settings } from "@petri/contracts";
import type { Metadata } from "next";
import { Hand } from "../../../components/notebook/index.tsx";
import { apiGet } from "../../../lib/api.ts";
import { requestCookie } from "../../../lib/session.ts";
import styles from "../dashboard.module.css";

export const metadata: Metadata = { title: "Settings" };

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const duration = (seconds: number) =>
	seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;

export default async function SettingsPage() {
	const cookie = await requestCookie();
	const { publicUrl, previewBaseUrl, version, limits } = await apiGet(
		"/api/v1/settings",
		settings,
		cookie ? { cookie } : {},
	);
	const previewHost = new URL(previewBaseUrl);

	return (
		<>
			<Hand as="h1">Settings</Hand>
			<p className={styles.lead}>
				Read-only here: settings are changed in the installation's{" "}
				<code>.env</code> (see <code>docs/operations.md</code>).
			</p>

			<section className={styles.section}>
				<Hand as="h2">This installation</Hand>
				<dl className={styles.facts}>
					<dt>Admin panel</dt>
					<dd>
						<a href={publicUrl}>{publicUrl}</a>
					</dd>
					<dt>Previews</dt>
					<dd>
						<code>{`${previewHost.protocol}//<name>.${previewHost.host}`}</code>
					</dd>
					<dt>Version</dt>
					<dd>
						{version === "development" ? (
							"development build"
						) : (
							<>
								commit <code title={version}>{version.slice(0, 10)}</code>
							</>
						)}
					</dd>
				</dl>
			</section>

			<section className={styles.section}>
				<Hand as="h2">Limits</Hand>
				<dl className={styles.facts}>
					<dt>ZIP upload</dt>
					<dd>
						{mb(limits.upload.maxBytes)} compressed,{" "}
						{mb(limits.upload.maxExtractedBytes)} extracted,{" "}
						{limits.upload.maxFiles.toLocaleString("en")} files
					</dd>
					<dt>Git repository</dt>
					<dd>
						{mb(limits.git.maxBytes)}, fetched within{" "}
						{duration(limits.git.timeoutSeconds)}
					</dd>
					<dt>Build</dt>
					<dd>{duration(limits.build.timeoutSeconds)}</dd>
					<dt>Each app</dt>
					<dd>
						{mb(limits.container.memoryBytes)} memory, {limits.container.cpus}{" "}
						CPU core
						{limits.container.cpus === 1 ? "" : "s"},{" "}
						{limits.container.processes} processes
					</dd>
					<dt>Start</dt>
					<dd>
						answers HTTP within {duration(limits.healthCheck.timeoutSeconds)}
					</dd>
					<dt>Temporary apps</dt>
					<dd>
						{limits.temporaryTtlHours.default} hours by default, at most{" "}
						{limits.temporaryTtlHours.max} hours
					</dd>
				</dl>
			</section>
		</>
	);
}
