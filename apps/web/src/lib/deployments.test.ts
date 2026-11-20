import { expect, test } from "vitest";
import { expiresSoon, timeLeft } from "./deployments.ts";

const now = Date.parse("2026-11-20T12:00:00Z");
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

test.each([
	[at(72), "3 days"],
	[at(48), "2 days"],
	[at(47.99), "48 hours"],
	[at(47.4), "47 hours"],
	[at(1), "1 hour"],
	[at(0.5), "30 minutes"],
	[at(0.001), "1 minute"],
	[at(-1), "moments"],
])("%s leaves %s", (expiresAt, expected) => {
	expect(timeLeft({ expiresAt, status: "ready" }, now)).toBe(expected);
});

test("nothing is left to count for permanent or expired ones", () => {
	expect(timeLeft({ expiresAt: null, status: "ready" }, now)).toBeNull();
	expect(timeLeft({ expiresAt: at(-1), status: "expired" }, now)).toBeNull();
	expect(timeLeft({ expiresAt: at(5), status: "deleted" }, now)).toBeNull();
});

test("expires soon: within a day, still able to", () => {
	expect(expiresSoon({ expiresAt: at(23), status: "stopped" }, now)).toBe(true);
	expect(expiresSoon({ expiresAt: at(25), status: "ready" }, now)).toBe(false);
	expect(expiresSoon({ expiresAt: at(-1), status: "expired" }, now)).toBe(
		false,
	);
	expect(expiresSoon({ expiresAt: null, status: "ready" }, now)).toBe(false);
});
