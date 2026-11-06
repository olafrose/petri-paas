"use client";

import { useRouter } from "next/navigation";

export function SignOutButton() {
	const router = useRouter();

	async function signOut() {
		await fetch("/api/v1/auth/sign-out", { method: "POST" });
		router.replace("/");
		router.refresh();
	}

	return (
		<button type="button" onClick={signOut}>
			Sign out
		</button>
	);
}
