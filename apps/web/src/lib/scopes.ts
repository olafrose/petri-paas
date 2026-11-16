import type { Scope } from "@petri/contracts";

/** Every scope, with what it allows in the interface's words. */
export const SCOPES: { scope: Scope; text: string }[] = [
	{
		scope: "deploy:read",
		text: "See experiments, cultures, logs and settings",
	},
	{ scope: "deploy:create", text: "Create experiments and grow cultures" },
	{ scope: "deploy:update", text: "Edit experiments; stop and start cultures" },
	{ scope: "deploy:delete", text: "Delete experiments and cultures" },
];
