import type { Metadata } from "next";
import { GalleryCard } from "../components/gallery/card.tsx";
import { Sketch } from "../components/notebook/index.tsx";
import { getGallery, previewImage } from "../lib/gallery.ts";
import { publicOrigin } from "../lib/public-url.ts";
import styles from "./page.module.css";

// Rendered on every request so the gallery is always current.
export const dynamic = "force-dynamic";

const description = "A little lab for big ideas: experiments you can try.";

export async function generateMetadata(): Promise<Metadata> {
	const { items } = await getGallery();
	const images = await previewImage(items.find((item) => item.image));
	return {
		title: { absolute: "petri. · experiments" },
		description,
		openGraph: {
			type: "website",
			siteName: "petri.",
			title: "petri. · experiments",
			description,
			url: await publicOrigin(),
			...(images && { images }),
		},
		twitter: { card: images ? "summary_large_image" : "summary" },
	};
}

export default async function GalleryPage() {
	const { items } = await getGallery();

	return (
		<>
			<h1 className={styles.title}>Experiments</h1>
			{items.length === 0 ? (
				<div className={styles.empty}>
					<Sketch kind="dish" />
					<p>Nothing on display yet. New experiments will appear here.</p>
				</div>
			) : (
				<ul className={styles.grid}>
					{items.map((item) => (
						<li key={item.slug}>
							<GalleryCard item={item} />
						</li>
					))}
				</ul>
			)}
		</>
	);
}
