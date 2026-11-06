"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import styles from "./login.module.css";

export function LoginForm({ next }: { next: string }) {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const form = new FormData(event.currentTarget);
		const response = await fetch("/api/v1/auth/sign-in/email", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				email: form.get("email"),
				password: form.get("password"),
			}),
		}).catch(() => null);
		setPending(false);

		if (response?.ok) {
			router.replace(next);
			router.refresh();
		} else if (response?.status === 429) {
			setError("Too many attempts. Please wait a minute and try again.");
		} else if (response?.status === 401) {
			setError("Email or password is incorrect.");
		} else {
			setError("Signing in failed. Please try again.");
		}
	}

	return (
		<form className={styles.form} onSubmit={onSubmit}>
			<h1>Sign in</h1>
			<label>
				Email
				<input name="email" type="email" autoComplete="username" required />
			</label>
			<label>
				Password
				<input
					name="password"
					type="password"
					autoComplete="current-password"
					required
				/>
			</label>
			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			<button type="submit" disabled={pending}>
				{pending ? "Signing in…" : "Sign in"}
			</button>
		</form>
	);
}
