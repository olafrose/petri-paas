import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeRedirectPath } from "../../lib/safe-redirect.ts";
import { getSession } from "../../lib/session.ts";
import { LoginForm } from "./login-form.tsx";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ next?: string }>;
}) {
	const next = safeRedirectPath((await searchParams).next);
	if (await getSession()) redirect(next);
	return <LoginForm next={next} />;
}
