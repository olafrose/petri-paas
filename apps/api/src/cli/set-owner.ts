// Creates the owner account or sets a new password:
//   pnpm owner:set --email you@example.com [--name "Your Name"]
// The password is read from the terminal (hidden), or from stdin when piped.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { databaseSchema, loadConfigOrExit } from "@petri/config";
import { createDatabase, migrateDatabase } from "@petri/database";
import { z } from "zod";
import { createAuth } from "../auth/auth.ts";
import { setOwner } from "../auth/owner.ts";

const { values } = parseArgs({
	options: {
		email: { type: "string" },
		name: { type: "string", default: "Owner" },
	},
});
const email = z.email().safeParse(values.email);
if (!email.success) {
	console.error("Usage: pnpm owner:set --email you@example.com [--name NAME]");
	process.exit(1);
}

const config = loadConfigOrExit(
	databaseSchema.extend({
		PUBLIC_URL: z.url(),
		AUTH_SECRET: z.string().min(32),
	}),
);

const password = process.stdin.isTTY
	? await promptHidden("Password: ")
	: (await readStdin()).replace(/\r?\n$/, "");
if (process.stdin.isTTY && (await promptHidden("Repeat: ")) !== password) {
	console.error("Passwords do not match.");
	process.exit(1);
}

const db = createDatabase(config.DATABASE_URL);
try {
	await migrateDatabase(db);
	const auth = createAuth({
		db,
		publicUrl: config.PUBLIC_URL,
		secret: config.AUTH_SECRET,
	});
	const result = await setOwner(auth, {
		email: email.data,
		name: values.name,
		password,
	});
	console.log(
		result === "created"
			? `Owner ${email.data} created.`
			: `Password for ${email.data} updated; existing sessions ended.`,
	);
} catch (error) {
	console.error((error as Error).message);
	process.exitCode = 1;
} finally {
	await db.$client.end();
}

function promptHidden(question: string): Promise<string> {
	let muted = false;
	const output = new Writable({
		write(chunk, _encoding, callback) {
			if (!muted) process.stdout.write(chunk);
			callback();
		},
	});
	const rl = createInterface({ input: process.stdin, output, terminal: true });
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			process.stdout.write("\n");
			resolve(answer);
		});
		muted = true;
	});
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}
