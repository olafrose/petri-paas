import { gallery } from "@petri/contracts";
import { apiGet } from "../lib/api.ts";
import styles from "./page.module.css";

// Rendered on every request so the gallery is always current.
export const dynamic = "force-dynamic";

export default async function GalleryPage() {
	const { items } = await apiGet("/api/v1/gallery", gallery);

	return (
		<>
			<h1 className={styles.title}>Experiments</h1>
			{items.length === 0 ? (
				<p className={styles.empty}>
					Nothing on display yet. New experiments will appear here.
				</p>
			) : (
				<ul className={styles.grid}>
					{items.map((item) => (
						<li key={item.slug} className={styles.card}>
							<h2>{item.name}</h2>
							{item.description && <p>{item.description}</p>}
							<p className={styles.meta}>
								{item.deployment.name} · updated{" "}
								<time dateTime={item.updatedAt}>
									{new Date(item.updatedAt).toLocaleDateString("en-GB", {
										day: "numeric",
										month: "short",
										year: "numeric",
									})}
								</time>
							</p>
						</li>
					))}
				</ul>
			)}
		</>
	);
}
