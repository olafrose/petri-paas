import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GalleryCard } from "../../../components/gallery/card.tsx";
import { getGalleryItem, previewImage } from "../../../lib/gallery.ts";
import { publicOrigin } from "../../../lib/public-url.ts";
import styles from "../../page.module.css";

// Always current: an experiment may leave the gallery at any time.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

/** One experiment, to share: its link preview shows its image. */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
	const item = await getGalleryItem((await params).slug);
	if (!item) return { title: "Not on display" };
	const images = await previewImage(item);
	const description =
		item.description || `An experiment in petri.: ${item.name}`;
	return {
		title: item.name,
		description,
		openGraph: {
			type: "website",
			siteName: "petri.",
			title: item.name,
			description,
			url: `${await publicOrigin()}/experiments/${item.slug}`,
			...(images && { images }),
		},
		twitter: { card: images ? "summary_large_image" : "summary" },
	};
}

export default async function ExperimentPage({ params }: Params) {
	const item = await getGalleryItem((await params).slug);
	if (!item) notFound();
	return (
		<>
			<p className={styles.back}>
				<a href="/">← All experiments</a>
			</p>
			<div className={styles.single}>
				<GalleryCard item={item} large />
			</div>
		</>
	);
}
