"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Reloads the page's server data every few seconds while `active`, e.g.
 * while a deployment is building. Renders nothing.
 */
export function AutoRefresh({
	active,
	intervalMs = 3000,
}: {
	active: boolean;
	intervalMs?: number;
}) {
	const router = useRouter();
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => router.refresh(), intervalMs);
		return () => clearInterval(timer);
	}, [active, intervalMs, router]);
	return null;
}
