import { expect, test } from "vitest";
import { slugify } from "./slug.ts";

test.each([
	["Dashboard Concept", "dashboard-concept"],
	["  Mockup v2!  ", "mockup-v2"],
	["Über Café", "uber-cafe"],
	["feature/new-navigation", "feature-new-navigation"],
	["a--b__c", "a-b-c"],
	["日本語", ""],
	["!!!", ""],
])("slugify(%j) = %j", (name, slug) => {
	expect(slugify(name)).toBe(slug);
});

test("truncates to 63 characters without a trailing hyphen", () => {
	const slug = slugify(`${"a".repeat(62)} b`);
	expect(slug).toBe("a".repeat(62));
	expect(slugify("x".repeat(100))).toHaveLength(63);
});
