export interface HealthCheckOptions {
	/** e.g. http://172.18.0.2:8080/ */
	url: string;
	/** Give up after this long. */
	timeoutMs?: number;
	/** Wait between attempts. */
	intervalMs?: number;
	/** Each attempt's own time limit. */
	requestTimeoutMs?: number;
	/** Checked between attempts; a stopped app fails at once. */
	isRunning?: () => Promise<{
		running: boolean;
		exitCode: number;
		oomKilled: boolean;
	}>;
	signal?: AbortSignal;
}

export type HealthCheckResult =
	| { healthy: true; status: number; attempts: number }
	| { healthy: false; reason: string; attempts: number };

/**
 * Waits until the app answers HTTP with a status below 500. Any answer
 * counts, including 404 or a redirect: the app is up, even if `/` is not
 * a page.
 */
export async function waitForHealthy(
	options: HealthCheckOptions,
): Promise<HealthCheckResult> {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const intervalMs = options.intervalMs ?? 2000;
	const deadline = Date.now() + timeoutMs;
	let attempts = 0;
	let lastProblem = "no answer yet";

	while (true) {
		if (options.signal?.aborted) {
			return {
				healthy: false,
				reason: "The health check was cancelled",
				attempts,
			};
		}
		attempts++;
		try {
			const response = await fetch(options.url, {
				redirect: "manual",
				signal: AbortSignal.timeout(options.requestTimeoutMs ?? 5000),
			});
			await response.body?.cancel();
			if (response.status < 500) {
				return { healthy: true, status: response.status, attempts };
			}
			lastProblem = `it answered with status ${response.status}`;
		} catch (error) {
			lastProblem = describeFetchError(error);
		}

		if (options.isRunning) {
			const state = await options.isRunning();
			if (!state.running) {
				return {
					healthy: false,
					reason: state.oomKilled
						? "The app was stopped for using more memory than allowed"
						: `The app stopped with exit code ${state.exitCode}`,
					attempts,
				};
			}
		}
		if (Date.now() + intervalMs > deadline) {
			return {
				healthy: false,
				reason: `The app did not answer within ${Math.round(timeoutMs / 1000)} s (${lastProblem})`,
				attempts,
			};
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

function describeFetchError(error: unknown): string {
	const cause = (error as { cause?: { code?: string } }).cause;
	if (cause?.code === "ECONNREFUSED") return "nothing is listening on the port";
	if ((error as Error).name === "TimeoutError") return "a request timed out";
	return (error as Error).message;
}
