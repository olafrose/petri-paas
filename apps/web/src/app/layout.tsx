import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import styles from "./layout.module.css";

export const metadata: Metadata = {
	title: { default: "petri.", template: "%s · petri." },
	description: "A little lab for big ideas: experiments you can try.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>
				<header className={styles.header}>
					<a href="/" className={styles.wordmark}>
						petri.
					</a>
				</header>
				<main className={styles.main}>{children}</main>
			</body>
		</html>
	);
}
