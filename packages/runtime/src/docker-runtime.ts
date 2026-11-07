import { createReadStream } from "node:fs";
import { DockerApiError, DockerClient } from "./docker-client.ts";

/** Labels on everything petri. creates, so it can be found again. */
export const LABELS = {
	managed: "dev.petri.managed",
	deployment: "dev.petri.deployment",
	build: "dev.petri.build",
} as const;

export interface ResourceLimits {
	memoryBytes: number;
	/** CPU cores, e.g. 1 or 0.5. */
	cpus: number;
	/** Maximum number of processes. */
	pids: number;
}

export const DEFAULT_LIMITS: ResourceLimits = {
	memoryBytes: 512 * 1024 * 1024,
	cpus: 1,
	pids: 256,
};

/**
 * Capabilities an app keeps. Everything else, including Docker's defaults
 * like NET_RAW, MKNOD and SYS_CHROOT, is dropped. These four are what
 * common images (e.g. nginx) need to switch to an unprivileged user and
 * listen on port 80.
 */
export const KEPT_CAPABILITIES = [
	"CHOWN",
	"SETUID",
	"SETGID",
	"NET_BIND_SERVICE",
] as const;

export interface ContainerSpec {
	deploymentId: string;
	buildId: string;
	image: string;
	/** Network from `ensureNetwork`. */
	network: string;
	env?: Record<string, string>;
	limits?: Partial<ResourceLimits>;
}

export interface ContainerState {
	id: string;
	status:
		| "created"
		| "running"
		| "paused"
		| "restarting"
		| "removing"
		| "exited"
		| "dead";
	running: boolean;
	exitCode: number;
	oomKilled: boolean;
	error: string;
	buildId: string | null;
	/** IP address per network name. */
	addresses: Record<string, string>;
}

/** The host silently ignored a resource limit; the app must not run. */
export class LimitsNotEnforcedError extends Error {
	constructor(missing: string[]) {
		super(
			`Docker did not apply the ${missing.join(", ")} limit. The host kernel lacks the cgroup controller for it (on a Raspberry Pi: add "cgroup_enable=memory" to /boot/firmware/cmdline.txt and reboot).`,
		);
		this.name = "LimitsNotEnforcedError";
	}
}

interface InspectResponse {
	Id: string;
	Config: { Labels: Record<string, string> | null };
	State: {
		Status: ContainerState["status"];
		Running: boolean;
		ExitCode: number;
		OOMKilled: boolean;
		Error: string;
	};
	NetworkSettings: { Networks: Record<string, { IPAddress: string }> | null };
}

const containerName = (deploymentId: string) => `petri-${deploymentId}`;
const networkName = (deploymentId: string) => `petri-${deploymentId}`;

/**
 * Runs deployments as Docker containers. Every operation is safe to
 * repeat: a retried job finds what an earlier attempt created instead of
 * creating duplicates.
 *
 * The security settings of a container are fixed here and cannot be
 * changed by callers: the Docker socket proxy limits which API sections
 * the worker may use, but not what a container-create request contains.
 */
export class DockerRuntime {
	readonly #docker: DockerClient;

	constructor(dockerHost: string) {
		this.#docker = new DockerClient(dockerHost);
	}

	/** Loads an image archive (from BuildKit) and returns the image id. */
	async loadImage(archivePath: string, imageName: string): Promise<string> {
		const response = await this.#docker.stream("POST", "/images/load", {
			query: { quiet: true },
			stream: createReadStream(archivePath),
			contentType: "application/x-tar",
		});
		let output = "";
		for await (const chunk of response) output += String(chunk);
		for (const line of output.split("\n")) {
			if (!line.trim()) continue;
			const message = JSON.parse(line) as { error?: string };
			if (message.error) {
				throw new DockerApiError(
					500,
					`Loading the image failed: ${message.error}`,
				);
			}
		}
		const { body } = await this.#docker.call<{ Id: string }>(
			"GET",
			`/images/${encodeURIComponent(imageName)}/json`,
		);
		return body.Id;
	}

	/** TCP ports the image declares with EXPOSE, lowest first. */
	async exposedPorts(imageName: string): Promise<number[]> {
		const { body } = await this.#docker.call<{
			Config: { ExposedPorts?: Record<string, unknown> | null };
		}>("GET", `/images/${encodeURIComponent(imageName)}/json`);
		return Object.keys(body.Config.ExposedPorts ?? {})
			.filter((key) => key.endsWith("/tcp"))
			.map((key) => Number.parseInt(key, 10))
			.filter((port) => port > 0 && port < 65536)
			.sort((a, b) => a - b);
	}

	async removeImage(imageName: string): Promise<void> {
		await this.#docker.call(
			"DELETE",
			`/images/${encodeURIComponent(imageName)}`,
			{
				query: { force: true },
				accept: [404, 409],
			},
		);
	}

	/** The deployment's own network; created if missing. */
	async ensureNetwork(deploymentId: string): Promise<string> {
		const name = networkName(deploymentId);
		const existing = await this.#docker.call(
			"GET",
			`/networks/${encodeURIComponent(name)}`,
			{ accept: [404] },
		);
		if (existing.status !== 404) return name;
		await this.#docker.call("POST", "/networks/create", {
			json: {
				Name: name,
				Driver: "bridge",
				Labels: {
					[LABELS.managed]: "true",
					[LABELS.deployment]: deploymentId,
				},
			},
			accept: [409], // created concurrently
		});
		return name;
	}

	async removeNetwork(deploymentId: string): Promise<void> {
		await this.#docker.call(
			"DELETE",
			`/networks/${encodeURIComponent(networkName(deploymentId))}`,
			{ accept: [404] },
		);
	}

	/** Attaches another container (the worker, the edge proxy) to a network. */
	async connect(network: string, containerId: string): Promise<void> {
		await this.#docker.call(
			"POST",
			`/networks/${encodeURIComponent(network)}/connect`,
			{
				json: { Container: containerId },
				accept: [403, 409], // already connected
			},
		);
	}

	async disconnect(network: string, containerId: string): Promise<void> {
		await this.#docker.call(
			"POST",
			`/networks/${encodeURIComponent(network)}/disconnect`,
			{ json: { Container: containerId, Force: true }, accept: [404] },
		);
	}

	/**
	 * Creates the deployment's container, or returns the existing one if it
	 * already runs this build. A container of an older build is replaced.
	 */
	async createContainer(spec: ContainerSpec): Promise<string> {
		const existing = await this.inspect(spec.deploymentId);
		if (existing?.buildId === spec.buildId) return existing.id;
		if (existing) await this.removeContainer(spec.deploymentId);

		const request = createBody(spec);
		const { body } = await this.#docker.call<{ Id: string }>(
			"POST",
			"/containers/create",
			{
				query: { name: containerName(spec.deploymentId) },
				json: request,
			},
		);
		await this.#verifyLimits(spec.deploymentId, request.HostConfig);
		return body.Id;
	}

	/**
	 * Docker accepts limits the kernel can't enforce and drops them with
	 * only a warning (e.g. no memory cgroup on a Raspberry Pi). Refuse to
	 * run an app without them.
	 */
	async #verifyLimits(
		deploymentId: string,
		requested: ReturnType<typeof createBody>["HostConfig"],
	) {
		const { body } = await this.#docker.call<{
			HostConfig: {
				Memory: number;
				NanoCpus: number;
				PidsLimit: number | null;
			};
		}>("GET", `/containers/${containerName(deploymentId)}/json`);
		const missing: string[] = [];
		if (body.HostConfig.Memory !== requested.Memory) missing.push("memory");
		if (body.HostConfig.NanoCpus !== requested.NanoCpus) missing.push("CPU");
		if (body.HostConfig.PidsLimit !== requested.PidsLimit)
			missing.push("process");
		if (missing.length > 0) {
			await this.removeContainer(deploymentId);
			throw new LimitsNotEnforcedError(missing);
		}
	}

	async start(deploymentId: string): Promise<void> {
		await this.#docker.call(
			"POST",
			`/containers/${containerName(deploymentId)}/start`,
			{ accept: [304] }, // already running
		);
	}

	async stop(deploymentId: string, timeoutSeconds = 10): Promise<void> {
		await this.#docker.call(
			"POST",
			`/containers/${containerName(deploymentId)}/stop`,
			{ query: { t: timeoutSeconds }, accept: [304, 404] },
		);
	}

	async removeContainer(deploymentId: string): Promise<void> {
		await this.#docker.call(
			"DELETE",
			`/containers/${containerName(deploymentId)}`,
			{ query: { force: true }, accept: [404] },
		);
	}

	/** The deployment's container, or null if there is none. */
	async inspect(deploymentId: string): Promise<ContainerState | null> {
		const { status, body } = await this.#docker.call<InspectResponse>(
			"GET",
			`/containers/${containerName(deploymentId)}/json`,
			{ accept: [404] },
		);
		if (status === 404) return null;
		return {
			id: body.Id,
			status: body.State.Status,
			running: body.State.Running,
			exitCode: body.State.ExitCode,
			oomKilled: body.State.OOMKilled,
			error: body.State.Error,
			buildId: body.Config.Labels?.[LABELS.build] ?? null,
			addresses: Object.fromEntries(
				Object.entries(body.NetworkSettings.Networks ?? {}).map(
					([name, info]) => [name, info.IPAddress],
				),
			),
		};
	}

	/** The last lines of the container's output. */
	async logs(deploymentId: string, tail = 200): Promise<string> {
		const response = await this.#docker.stream(
			"GET",
			`/containers/${containerName(deploymentId)}/logs`,
			{ query: { stdout: true, stderr: true, tail, timestamps: true } },
		);
		return demultiplex(Buffer.concat(await collect(response)));
	}
}

/** The container-create request. The only place security settings are set. */
export function createBody(spec: ContainerSpec) {
	const limits = { ...DEFAULT_LIMITS, ...spec.limits };
	return {
		Image: spec.image,
		Env: Object.entries(spec.env ?? {}).map(
			([key, value]) => `${key}=${value}`,
		),
		Labels: {
			[LABELS.managed]: "true",
			[LABELS.deployment]: spec.deploymentId,
			[LABELS.build]: spec.buildId,
		},
		HostConfig: {
			NetworkMode: spec.network,
			Memory: limits.memoryBytes,
			MemorySwap: limits.memoryBytes, // no swap on top
			NanoCpus: Math.round(limits.cpus * 1e9),
			PidsLimit: limits.pids,
			CapDrop: ["ALL"],
			CapAdd: [...KEPT_CAPABILITIES],
			SecurityOpt: ["no-new-privileges:true"],
			Privileged: false,
			// No host ports, mounts or devices.
			PublishAllPorts: false,
			PortBindings: {},
			Binds: [],
			Mounts: [],
			Devices: [],
			// Reaps zombie processes; apps don't need their own init.
			Init: true,
			RestartPolicy: { Name: "unless-stopped" },
			LogConfig: {
				Type: "json-file",
				Config: { "max-size": "10m", "max-file": "3" },
			},
		},
	};
}

function collect(stream: AsyncIterable<Buffer | string>): Promise<Buffer[]> {
	return (async () => {
		const chunks: Buffer[] = [];
		for await (const chunk of stream) chunks.push(Buffer.from(chunk));
		return chunks;
	})();
}

/** Docker's log stream frames: 8-byte header (stream, size) + payload. */
function demultiplex(data: Buffer): string {
	let output = "";
	let offset = 0;
	while (offset + 8 <= data.length) {
		const size = data.readUInt32BE(offset + 4);
		output += data.subarray(offset + 8, offset + 8 + size).toString("utf8");
		offset += 8 + size;
	}
	return output;
}
