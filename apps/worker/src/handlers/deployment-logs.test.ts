import { describe, expect, test } from "vitest";
import { keepEnd, shortenTimes } from "./deployment-logs.ts";

describe("shortenTimes", () => {
	test("cuts Docker's times to whole seconds, only at line starts", () => {
		expect(
			shortenTimes(
				"2026-11-09T21:04:05.123456789Z ready\n2026-11-09T21:04:06.5Z at 2026-11-09T21:04:06.5Z \n",
			),
		).toBe(
			"2026-11-09T21:04:05Z ready\n2026-11-09T21:04:06Z at 2026-11-09T21:04:06.5Z \n",
		);
	});
});

describe("keepEnd", () => {
	test("keeps short text as it is", () => {
		expect(keepEnd("a\nb\n", 10)).toEqual({ text: "a\nb\n", truncated: false });
	});

	test("keeps the end, from the first whole line", () => {
		expect(keepEnd("first\nsecond\nthird\n", 10)).toEqual({
			text: "third\n",
			truncated: true,
		});
	});

	test("never splits a character", () => {
		const { text } = keepEnd("ä".repeat(20), 9);
		expect(text).not.toContain("�");
	});
});
