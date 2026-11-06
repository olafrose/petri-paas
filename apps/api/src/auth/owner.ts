import type { Auth } from "./auth.ts";

export interface OwnerInput {
	email: string;
	name: string;
	password: string;
}

/**
 * Creates the owner account, or sets a new password if the owner already
 * exists. Refuses if a different user exists: petri. has a single owner.
 */
export async function setOwner(
	auth: Auth,
	{ email, name, password }: OwnerInput,
): Promise<"created" | "updated"> {
	const ctx = await auth.$context;
	const normalizedEmail = email.trim().toLowerCase();
	const { minPasswordLength, maxPasswordLength } = ctx.password.config;
	if (password.length < minPasswordLength) {
		throw new Error(
			`Password must be at least ${minPasswordLength} characters`,
		);
	}
	if (password.length > maxPasswordLength) {
		throw new Error(`Password must be at most ${maxPasswordLength} characters`);
	}

	const existing = await ctx.adapter.findMany<{ id: string; email: string }>({
		model: "user",
		limit: 2,
	});
	const other = existing.find((user) => user.email !== normalizedEmail);
	if (other) {
		throw new Error(
			`Another user (${other.email}) is already the owner. petri. supports a single owner.`,
		);
	}

	const hash = await ctx.password.hash(password);
	const owner = existing[0];
	if (owner) {
		const credential = (await ctx.internalAdapter.findAccounts(owner.id)).find(
			(account) => account.providerId === "credential",
		);
		if (credential) {
			await ctx.internalAdapter.updatePassword(owner.id, hash);
		} else {
			await ctx.internalAdapter.linkAccount({
				userId: owner.id,
				providerId: "credential",
				accountId: owner.id,
				password: hash,
			});
		}
		// A new password ends all existing sessions.
		await ctx.internalAdapter.deleteUserSessions(owner.id);
		return "updated";
	}

	const user = await ctx.internalAdapter.createUser(
		{ email: normalizedEmail, name, emailVerified: true },
		{ method: "admin" },
	);
	await ctx.internalAdapter.linkAccount({
		userId: user.id,
		providerId: "credential",
		accountId: user.id,
		password: hash,
	});
	return "created";
}
