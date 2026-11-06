import { deploymentStatus as apiStatus } from "@petri/contracts";
import { deploymentStatus as dbStatus } from "@petri/database";
import { expect, test } from "vitest";

// The API contract repeats the database enum so the web app needn't
// depend on the database package. Keep them identical.
test("API and database agree on deployment statuses", () => {
	expect(apiStatus.options).toEqual(dbStatus.enumValues);
});
