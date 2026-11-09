import type { DeploymentStatus } from "@petri/contracts";
import type { Metadata } from "next";
import {
	Button,
	ButtonLink,
	DateStamp,
	ExperimentNumber,
	Field,
	Hand,
	Label,
	LogView,
	MarginNote,
	Sketch,
	StatusStamp,
} from "../../../components/notebook/index.tsx";
import styles from "./styleguide.module.css";

export const metadata: Metadata = { title: "Style guide" };

/*
 * The lab notebook's building blocks in one place (task 4.1): a reference
 * for building screens, and a quick check after changing the theme.
 */

const SAMPLE_LOG = `[petri] Fetching source
[petri] Fetched main at 3f9c2a1e
[petri] Building image
#5 [2/3] RUN npm ci
#5 DONE 14.2s
#7 exporting to docker image format
[petri] Starting the app
[petri] Waiting for the app to answer on port 3000
[petri] Ready at https://dashboard-concept-main.app.example.com/`;

const STATUSES: DeploymentStatus[] = [
	"queued",
	"building",
	"health_check",
	"ready",
	"failed",
	"stopped",
	"expired",
	"deleted",
];

export default function StyleGuidePage() {
	return (
		<div>
			<header className={styles.intro}>
				<Hand as="h1">Style guide</Hand>
				<p>
					The lab notebook's building blocks. Screens are made from these;
					change the theme in <code>globals.css</code> and check here.
				</p>
			</header>

			<section className={styles.section}>
				<Hand as="h2">An entry in the notebook</Hand>
				<article className={styles.entry}>
					<div className={styles.entryHead}>
						<ExperimentNumber number={7} />
						<DateStamp date="2026-11-09" />
					</div>
					<Hand as="h3">Dashboard concept</Hand>
					<p>
						A new way to read the week's numbers at a glance. Three layouts, one
						chosen by a vote of two.
					</p>
					<div className={styles.entryFoot}>
						<StatusStamp status="ready" />
						<Label>main</Label>
						<Label>public</Label>
						<MarginNote>try the dark one! →</MarginNote>
					</div>
				</article>
			</section>

			<section className={styles.section}>
				<Hand as="h2">Status stamps</Hand>
				<div className={styles.row}>
					{STATUSES.map((status) => (
						<StatusStamp key={status} status={status} />
					))}
				</div>
			</section>

			<section className={styles.section}>
				<Hand as="h2">Text</Hand>
				<p>
					Body text stays plain and readable: descriptions, notes, forms and
					logs are never handwritten. <a href="#text">Links look like this</a>,
					and <code>code</code> like this.
				</p>
				<p className={styles.soft}>Secondary text, for details and hints.</p>
			</section>

			<section className={styles.section}>
				<Hand as="h2">Buttons and labels</Hand>
				<div className={styles.row}>
					<Button>Deploy</Button>
					<Button variant="secondary">Stop</Button>
					<Button variant="danger">Delete</Button>
					<ButtonLink href="#try">Try it →</ButtonLink>
					<Label>main</Label>
					<Label>temporary · 48 h</Label>
				</div>
			</section>

			<section className={styles.section}>
				<Hand as="h2">A form</Hand>
				<form className={styles.form}>
					<Field
						label="Repository"
						hint="An HTTPS URL of a public Git repository"
					>
						<input defaultValue="https://github.com/example/dashboard" />
					</Field>
					<Field
						label="Branch, tag or commit"
						error="Branch, tag or commit not found"
					>
						<input defaultValue="mian" />
					</Field>
					<Field label="Notes">
						<textarea
							rows={3}
							defaultValue="Try the colour scheme from the poster."
						/>
					</Field>
				</form>
			</section>

			<section className={styles.section}>
				<Hand as="h2">A build log</Hand>
				<LogView text={SAMPLE_LOG} />
			</section>

			<section className={styles.section}>
				<Hand as="h2">Empty pages</Hand>
				<div className={styles.empties}>
					<div className={styles.empty}>
						<Sketch kind="dish" />
						<p>No experiments yet. Start one with your first deployment.</p>
					</div>
					<div className={styles.empty}>
						<Sketch kind="flask" />
						<p>Nothing on display yet. New experiments will appear here.</p>
					</div>
				</div>
			</section>

			<section className={styles.section}>
				<Hand as="h2">A gallery card</Hand>
				<article className={styles.card}>
					<div className={styles.cardImage}>
						<Sketch kind="dish" size={90} />
					</div>
					<div className={styles.cardBody}>
						<Hand as="h3">Dashboard concept</Hand>
						<p>A new way to read the week's numbers at a glance.</p>
						<div className={styles.row}>
							<StatusStamp status="ready" />
							<Label>main</Label>
							<DateStamp date="2026-11-09" />
						</div>
						<ButtonLink href="#try">Try it →</ButtonLink>
					</div>
				</article>
			</section>
		</div>
	);
}
