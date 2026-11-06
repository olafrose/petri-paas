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
				<span>Signed in as {session.user.email}</span>
				<SignOutButton />
			</div>
			{children}
		</>
	);
}
