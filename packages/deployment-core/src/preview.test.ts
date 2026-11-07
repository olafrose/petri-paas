import { expect, test } from "vitest";
import { previewHostname, previewUrl } from "./preview.ts";

test.each([
	["https://app.example.com", "https://demo-main.app.example.com/"],
	["https://app.example.com/", "https://demo-main.app.example.com/"],
	["http://app.localhost:8088", "http://demo-main.app.localhost:8088/"],
	["https://APP.Example.com", "https://demo-main.app.example.com/"],
])("%s", (base, expected) => {
	expect(previewUrl(base, "demo-main")).toBe(expected);
});

test("the hostname leaves out scheme and port", () => {
	expect(previewHostname("http://app.localhost:8088", "demo-main")).toBe(
		"demo-main.app.localhost",
	);
});
