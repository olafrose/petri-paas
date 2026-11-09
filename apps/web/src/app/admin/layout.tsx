import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { SignOutButton } from "../../components/sign-out-button.tsx";
import { getSession } from "../../lib/session.ts";
import styles from "./admin.module.css";

// Never cache: every admin request checks the session.
export const dynamic = "force-dynamic";

export default async function AdminLayout({
	children,
}: {
	children: ReactNode;
}) {
	const session = await getSession();
	if (!session) redirect("/login?next=/admin");

	return (
		<>
			<div className={styles.bar}>
				<nav className={styles.nav} aria-label="Admin">
					<a href="/admin">Experiments</a>
					<a href="/admin/deploy">New deployment</a>
					<a href="/admin/api-keys">API keys</a>
					<a href="/admin/settings">Settings</a>
				</nav>
				<span className={styles.user}>
					{session.user.email}
					<SignOutButton />
				</span>
			</div>
			{children}
		</>
	);
}
