import { BuildError, SourceError } from "@petri/build-engine";
import {
	type DockerRuntime,
	type HealthCheckResult,
	LimitsNotEnforcedError,
	waitForHealthy,
} from "@petri/runtime";

/*
 * Running and checking a deployment's app: shared by the jobs that start
 * it (deployment.run, deployment.start) and the one that removes it.
 */

/** A step failed for a reason worth showing the owner. */
export class StepFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StepFailure";
	}
}

/** Errors whose message is written for the owner. */
export function ownerMessage(error: unknown): string | null {
	if (
		error instanceof StepFailure ||
		error instanceof SourceError ||
		error instanceof BuildError ||
		error instanceof LimitsNotEnforcedError
	) {
		return error.message;
	}
	return null;
}

/** The image of one build of a deployment. */
export const imageName = (deploymentId: string, buildId: string) =>
	`petri/${deploymentId}:${buildId}`;

export interface HealthSettings {
	/** Set when the worker runs in a container (see WORKER_CONTAINER). */
	workerContainer?: string | undefined;
	health?: { timeoutMs?: number; intervalMs?: number };
}

/** The configured port, or the one the image declares with EXPOSE. */
export async function choosePort(
	runtime: DockerRuntime,
	imageName: string,
	configured: number | null,
	note: (line: string) => void,
): Promise<number> {
	if (configured) return configured;
	const exposed = await runtime.exposedPorts(imageName);
	const [first] = exposed;
	if (first === undefined) {
		throw new StepFailure(
			"No port known: set build.port, or add EXPOSE <port> to the Dockerfile",
		);
	}
	if (exposed.length > 1) {
		note(
			`The image exposes ${exposed.join(", ")}; using ${first} (set build.port to choose)`,
		);
	}
	return first;
}

/**
 * Waits for the app to answer. An app that stops, even before it got an
 * address, is a failed check like any other, so callers keep its output.
 */
export async function checkHealth(
	runtime: DockerRuntime,
	settings: HealthSettings,
	deploymentId: string,
	network: string,
	port: number,
	signal: AbortSignal,
): Promise<HealthCheckResult> {
	// In a container, the worker must join the app's network to reach it.
	if (settings.workerContainer) {
		await runtime.connect(network, settings.workerContainer);
	}
	try {
		let address: string;
		try {
			address = await waitForAddress(runtime, deploymentId, network);
		} catch (error) {
			if (!(error instanceof StepFailure)) throw error;
			return { healthy: false, reason: error.message, attempts: 0 };
		}
		return await waitForHealthy({
			url: `http://${address}:${port}/`,
			signal,
			...settings.health,
			isRunning: async () => {
				const current = await runtime.inspect(deploymentId);
				return {
					running: current?.running ?? false,
					exitCode: current?.exitCode ?? -1,
					oomKilled: current?.oomKilled ?? false,
				};
			},
		});
	} finally {
		if (settings.workerContainer) {
			await runtime
				.disconnect(network, settings.workerContainer)
				.catch(() => {});
		}
	}
}

/**
 * The app's address on its network. A container that already stopped has
 * none; report why it stopped instead.
 */
async function waitForAddress(
	runtime: DockerRuntime,
	deploymentId: string,
	network: string,
): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const state = await runtime.inspect(deploymentId);
		const address = state?.addresses[network];
		if (state?.running && address) return address;
		if (state && !state.running && state.status !== "created") {
			throw new StepFailure(
				state.oomKilled
					? "The app was stopped for using more memory than allowed"
					: `The app stopped with exit code ${state.exitCode}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new StepFailure("The app's container did not get a network address");
}
