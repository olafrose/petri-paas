// Started as a child process by reconcile.int.test.ts: runs one build of
// a deployment until the test kills it mid-way, as when the worker's
// container dies. Everything comes from the environment.
import { randomUUID } from "node:crypto";
import { createDatabase } from "@petri/database";
import { DockerRuntime } from "@petri/runtime";
import { pino } from "pino";
import { deploymentRunHandler } from "../src/handlers/deployment-run.ts";
import { testEdge } from "./edge.ts";

const env = (name: string) => process.env[name] as string;
const runtime = new DockerRuntime(env("DOCKER_PROXY_HOST"));
await deploymentRunHandler({
	db: createDatabase(env("DATABASE_URL")),
	runtime,
	edge: testEdge(runtime),
	log: pino({ level: "silent" }),
	settings: JSON.parse(env("RUN_SETTINGS")),
})({
	id: randomUUID(),
	data: { deploymentId: env("DEPLOYMENT_ID"), buildId: env("BUILD_ID") },
	retryCount: 0,
	signal: new AbortController().signal,
});
process.exit(0);
