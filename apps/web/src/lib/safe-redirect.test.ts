import { expect, test } from "vitest";
import { safeRedirectPath } from "./safe-redirect.ts";

test.each([
	["/admin/projects?tab=2", "/admin/projects?tab=2"],
	["/admin#notes", "/admin#notes"],
	[undefined, "/admin"],
	[null, "/admin"],
	["", "/admin"],
	["admin", "/admin"],
	["https://evil.example/admin", "/admin"],
	["//evil.example/admin", "/admin"],
	["/\\evil.example", "/admin"],
	["\\/evil.example", "/admin"],
	["/\t/evil.example", "/admin"],
	["javascript:alert(1)", "/admin"],
])("safeRedirectPath(%j) = %j", (next, expected) => {
	expect(safeRedirectPath(next)).toBe(expected);
});
