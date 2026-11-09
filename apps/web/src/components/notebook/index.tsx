import type { DeploymentStatus } from "@petri/contracts";
import type { ComponentProps, ReactNode } from "react";
import styles from "./notebook.module.css";

/*
 * The lab notebook's building blocks (task 4.1). Server components: no
 * JavaScript reaches the browser for any of them.
 */

/** A project's number, e.g. EXP-007. */
export function ExperimentNumber({ number }: { number: number }) {
	return (
		<span className={styles.experiment}>
			EXP-{String(number).padStart(3, "0")}
		</span>
	);
}

/** A date as a stamp: 09 NOV 2026. */
export function DateStamp({ date }: { date: Date | string }) {
	const value = new Date(date);
	const text = value
		.toLocaleDateString("en-GB", {
			day: "2-digit",
			month: "short",
			year: "numeric",
			timeZone: "UTC",
		})
		.toUpperCase();
	return (
		<time className={styles.date} dateTime={value.toISOString()}>
			{text}
		</time>
	);
}

const STATUS: Record<
	DeploymentStatus,
	{ text: string; tone: "ok" | "busy" | "failed" | "idle" }
> = {
	queued: { text: "queued", tone: "busy" },
	cloning: { text: "fetching", tone: "busy" },
	building: { text: "building", tone: "busy" },
	deploying: { text: "starting", tone: "busy" },
	health_check: { text: "checking", tone: "busy" },
	ready: { text: "ready", tone: "ok" },
	failed: { text: "failed", tone: "failed" },
	stopped: { text: "stopped", tone: "idle" },
	expired: { text: "expired", tone: "idle" },
	deleting: { text: "deleting", tone: "busy" },
	deleted: { text: "deleted", tone: "idle" },
};

/** A deployment's status as a rubber stamp. */
export function StatusStamp({ status }: { status: DeploymentStatus }) {
	const { text, tone } = STATUS[status];
	return <span className={`${styles.stamp} ${styles[tone]}`}>{text}</span>;
}

export function Label({ children }: { children: ReactNode }) {
	return <span className={styles.label}>{children}</span>;
}

/** Handwritten text: headings and margin notes, never for content. */
export function Hand({
	as: Tag = "span",
	children,
}: {
	as?: "span" | "h1" | "h2" | "h3";
	children: ReactNode;
}) {
	return <Tag className={styles.hand}>{children}</Tag>;
}

/** A note in the margin, in the accent colour. */
export function MarginNote({ children }: { children: ReactNode }) {
	return <span className={styles.note}>{children}</span>;
}

type Variant = "primary" | "secondary" | "danger";

const variantClass = (variant: Variant) =>
	`${styles.button} ${variant === "primary" ? "" : styles[variant]}`;

export function Button({
	variant = "primary",
	...props
}: ComponentProps<"button"> & { variant?: Variant }) {
	return <button type="button" className={variantClass(variant)} {...props} />;
}

export function ButtonLink({
	variant = "primary",
	...props
}: ComponentProps<"a"> & { variant?: Variant }) {
	return <a className={variantClass(variant)} {...props} />;
}

/** A labelled form field with an optional hint or error below it. */
export function Field({
	label,
	hint,
	error,
	children,
}: {
	label: string;
	hint?: string;
	error?: string;
	children: ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children, inside the label
		<label className={styles.field}>
			{label}
			{children}
			{error ? (
				<span className={styles.fieldError}>{error}</span>
			) : (
				hint && <span className={styles.hint}>{hint}</span>
			)}
		</label>
	);
}

/** A build or runtime log. petri.'s own lines are highlighted. */
export function LogView({ text }: { text: string }) {
	// Each line keyed by where it starts in the log: unique and stable.
	let offset = 0;
	const lines = text.split("\n").map((line) => {
		const entry = { line, start: offset };
		offset += line.length + 1;
		return entry;
	});
	return (
		<pre className={styles.log}>
			{lines.map(({ line, start }) => (
				<span
					key={start}
					className={line.startsWith("[petri]") ? styles.logPetri : undefined}
				>
					{line}
					{"\n"}
				</span>
			))}
		</pre>
	);
}

/** Hand-drawn sketches for empty states. */
export function Sketch({
	kind,
	size = 120,
}: {
	kind: "dish" | "flask";
	size?: number;
}) {
	return (
		<svg
			className={styles.sketch}
			width={size}
			height={size}
			viewBox="0 0 120 120"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{kind === "dish" ? (
				<>
					{/* A petri dish from above: rim, lid edge, a few colonies. */}
					<path d="M60 18c24 0 43 18 42 41c0 24-19 43-43 42c-23 0-41-19-41-42c1-22 19-41 42-41z" />
					<path
						d="M60 25c19 0 35 15 35 34c-1 20-16 35-36 35c-19 0-34-15-34-35c0-18 16-34 35-34"
						opacity="0.5"
					/>
					<circle cx="48" cy="50" r="5" />
					<circle cx="70" cy="66" r="3.5" />
					<circle cx="62" cy="44" r="2" />
					<circle cx="52" cy="72" r="2.5" />
					<path d="M98 30l12-10M104 36l10-2" opacity="0.6" />
				</>
			) : (
				<>
					{/* An Erlenmeyer flask, half full, a bubble rising. */}
					<path d="M48 16h24M51 16v30L28 94c-3 7 1 12 8 12h48c7 0 11-5 8-12L69 46V16" />
					<path d="M36 80c8-3 16 3 24 0s16-3 24 0" opacity="0.6" />
					<circle cx="58" cy="66" r="3" />
					<circle cx="66" cy="56" r="2" />
				</>
			)}
		</svg>
	);
}
