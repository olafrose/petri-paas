import type { GalleryItem } from "@petri/contracts";
import {
	ButtonLink,
	DateStamp,
	Sketch,
	StatusStamp,
} from "../notebook/index.tsx";
import styles from "./card.module.css";

/**
 * An experiment in the public gallery. Shows only what the gallery API
 * returns; server-rendered, no JavaScript.
 */
export function GalleryCard({
	item,
	large = false,
}: {
	item: GalleryItem;
	/** On the experiment's own page. */
	large?: boolean;
}) {
	return (
		<article className={`${styles.card} ${large ? styles.large : ""}`}>
			{item.image ? (
				// biome-ignore lint/performance/noImgElement: served by the API, sized
				<img
					className={styles.image}
					src={item.image.url}
					width={item.image.width}
					height={item.image.height}
					alt=""
					loading={large ? "eager" : "lazy"}
				/>
			) : (
				<div className={styles.placeholder}>
					<Sketch kind="flask" size={large ? 140 : 96} />
				</div>
			)}
			<div className={styles.body}>
				{large ? (
					<h1 className={styles.name}>{item.name}</h1>
				) : (
					<h2 className={styles.name}>
						<a href={`/experiments/${item.slug}`}>{item.name}</a>
					</h2>
				)}
				{item.description && (
					<p className={styles.description}>{item.description}</p>
				)}
				<p className={styles.meta}>
					<StatusStamp status={item.deployment.status} />
					<span className={styles.version}>{item.deployment.name}</span>
					<span>
						updated <DateStamp date={item.updatedAt} />
					</span>
				</p>
				<div className={styles.actions}>
					<ButtonLink
						href={item.deployment.url}
						target="_blank"
						rel="noopener"
						aria-label={`Try ${item.name} (opens in a new tab)`}
					>
						Try it ↗
					</ButtonLink>
				</div>
			</div>
		</article>
	);
}
