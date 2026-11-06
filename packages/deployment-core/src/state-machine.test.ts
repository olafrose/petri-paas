import { deploymentStatus } from "@petri/database";
import { describe, expect, test } from "vitest";
import {
	actionTarget,
	availableActions,
	canPerform,
	canTransition,
	type DeploymentAction,
	isActive,
	TRANSITIONS,
} from "./state-machine.ts";

const ALL = deploymentStatus.enumValues;

describe("transition table", () => {
	test("covers every status, and only known statuses", () => {
		expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL].sort());
		for (const targets of Object.values(TRANSITIONS)) {
			for (const target of targets) expect(ALL).toContain(target);
		}
	});

	test("the build path leads from queued to ready", () => {
		const path = [
			"queued",
			"cloning",
			"building",
			"deploying",
			"health_check",
			"ready",
		] as const;
		for (let i = 0; i < path.length - 1; i++) {
			expect(canTransition(path[i] as never, path[i + 1] as never)).toBe(true);
		}
	});

	test.each([
		"queued",
		"cloning",
		"building",
		"deploying",
		"health_check",
		"ready",
	] as const)("%s can fail", (status) => {
		expect(canTransition(status, "failed")).toBe(true);
	});

	test("every status except the end can be deleted", () => {
		for (const status of ALL) {
			if (status === "deleting" || status === "deleted") continue;
			expect(canTransition(status, "deleting"), status).toBe(true);
		}
		expect(canTransition("deleting", "deleted")).toBe(true);
		expect(TRANSITIONS.deleted).toEqual([]);
	});

	test.each([
		["queued", "ready"],
		["queued", "building"],
		["cloning", "health_check"],
		["building", "ready"],
		["ready", "building"],
		["ready", "ready"],
		["failed", "ready"],
		["failed", "deploying"],
		["stopped", "ready"],
		["expired", "ready"],
		["expired", "deploying"],
		["deleting", "queued"],
		["deleting", "failed"],
		["deleted", "queued"],
	] as const)("%s → %s is refused", (from, to) => {
		expect(canTransition(from, to)).toBe(false);
	});

	test("every status is reachable from queued", () => {
		const reached = new Set<string>(["queued"]);
		const pending = ["queued"] as (keyof typeof TRANSITIONS)[];
		while (pending.length > 0) {
			const status = pending.pop() as keyof typeof TRANSITIONS;
			for (const next of TRANSITIONS[status]) {
				if (!reached.has(next)) {
					reached.add(next);
					pending.push(next);
				}
			}
		}
		expect([...reached].sort()).toEqual([...ALL].sort());
	});
});

describe("actions", () => {
	test.each([
		["queued", ["delete"]],
		["cloning", ["delete"]],
		["building", ["delete"]],
		["deploying", ["delete"]],
		["health_check", ["delete"]],
		["ready", ["stop", "redeploy", "delete"]],
		["stopped", ["start", "redeploy", "delete"]],
		["failed", ["redeploy", "delete"]],
		["expired", ["redeploy", "delete"]],
		["deleting", []],
		["deleted", []],
	] as const)("%s offers %j", (status, actions) => {
		expect(availableActions(status)).toEqual(actions);
	});

	test("every offered action is an allowed transition", () => {
		const actions: DeploymentAction[] = ["stop", "start", "redeploy", "delete"];
		for (const status of ALL) {
			for (const action of actions) {
				if (canPerform(action, status)) {
					expect(
						canTransition(status, actionTarget(action)),
						`${action} from ${status}`,
					).toBe(true);
				}
			}
		}
	});
});

test("active statuses are the ones the job works on", () => {
	expect(ALL.filter(isActive)).toEqual([
		"queued",
		"cloning",
		"building",
		"deploying",
		"health_check",
	]);
});
