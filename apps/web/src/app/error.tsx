"use client";

/** Shown when a page fails to load, e.g. because the API is unreachable. */
export default function ErrorPage({ reset }: { reset: () => void }) {
	return (
		<>
			<h1>Something went wrong</h1>
			<p>This page could not be loaded. Please try again in a moment.</p>
			<button type="button" onClick={reset}>
				Try again
			</button>
		</>
	);
}
