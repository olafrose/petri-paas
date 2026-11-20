import { TTL_HOURS } from "@petri/contracts";
import type { Access } from "./access.ts";

/** An endpoint the guide names, with the access it claims. */
export interface GuideEndpoint {
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	/** As registered, e.g. /api/v1/deployments/:id */
	path: string;
	access: Access;
	text: string;
}

/** The endpoints table; a test checks each against the real routes. */
export const GUIDE_ENDPOINTS: GuideEndpoint[] = [
	{
		method: "POST",
		path: "/api/v1/access-requests",
		access: "public",
		text: "Ask the owner for a key",
	},
	{
		method: "POST",
		path: "/api/v1/access-requests/token",
		access: "public",
		text: "Collect the key once granted",
	},
	{
		method: "GET",
		path: "/api/v1/settings",
		access: { scope: "deploy:read" },
		text: "Limits in force (upload size, build time, memory, TTL)",
	},
	{
		method: "GET",
		path: "/api/v1/projects",
		access: { scope: "deploy:read" },
		text: "Experiments",
	},
	{
		method: "PATCH",
		path: "/api/v1/projects/:id",
		access: { scope: "deploy:update" },
		text: "Describe an experiment (name, description, notes)",
	},
	{
		method: "POST",
		path: "/api/v1/deployments",
		access: { scope: "deploy:create" },
		text: "Grow a culture from Git",
	},
	{
		method: "POST",
		path: "/api/v1/deployments/upload",
		access: { scope: "deploy:create" },
		text: "Grow a culture from a ZIP archive",
	},
	{
		method: "GET",
		path: "/api/v1/deployments",
		access: { scope: "deploy:read" },
		text: "Cultures (`?projectId=`, `?status=`)",
	},
	{
		method: "GET",
		path: "/api/v1/deployments/:id",
		access: { scope: "deploy:read" },
		text: "One culture: `status`, `url`, `latestBuild`",
	},
	{
		method: "GET",
		path: "/api/v1/deployments/:id/events",
		access: { scope: "deploy:read" },
		text: "Its history (`?after=<id>`)",
	},
	{
		method: "GET",
		path: "/api/v1/deployments/:id/events/stream",
		access: { scope: "deploy:read" },
		text: "The same, live (Server-Sent Events)",
	},
	{
		method: "GET",
		path: "/api/v1/deployments/:id/logs",
		access: { scope: "deploy:read" },
		text: "Build log (`?build=<id>`); `?source=runtime` for the app's output",
	},
	{
		method: "GET",
		path: "/api/v1/deployments/:id/builds",
		access: { scope: "deploy:read" },
		text: "Its builds, newest first, with commit and result",
	},
	{
		method: "PATCH",
		path: "/api/v1/deployments/:id",
		access: { scope: "deploy:update" },
		text: 'Extend it (`{"lifecycle": {"mode": "temporary", "ttlHours": 48}}`)',
	},
	{
		method: "POST",
		path: "/api/v1/deployments/:id/redeploy",
		access: { scope: "deploy:update" },
		text: 'Build again from Git (`{"ref": ...}` to change it)',
	},
	{
		method: "POST",
		path: "/api/v1/deployments/:id/upload",
		access: { scope: "deploy:update" },
		text: "Build again from a new ZIP archive",
	},
	{
		method: "POST",
		path: "/api/v1/deployments/:id/stop",
		access: { scope: "deploy:update" },
		text: "Stop",
	},
	{
		method: "POST",
		path: "/api/v1/deployments/:id/start",
		access: { scope: "deploy:update" },
		text: "Start again",
	},
	{
		method: "DELETE",
		path: "/api/v1/deployments/:id",
		access: { scope: "deploy:delete" },
		text: "Delete (the history stays)",
	},
];

const accessText = (access: Access) =>
	access === "public"
		? "no key"
		: access === "owner"
			? "owner only"
			: `\`${access.scope}\``;

/**
 * How to use petri., for coding assistants: one page, in Markdown,
 * with this instance's addresses.
 */
export function renderGuide({
	publicUrl,
	previewBaseUrl,
}: {
	publicUrl: string;
	previewBaseUrl: string;
}): string {
	const api = new URL("/api/v1", publicUrl).toString();
	const previewHost = new URL(previewBaseUrl).host;
	const previewScheme = new URL(previewBaseUrl).protocol;
	const table = GUIDE_ENDPOINTS.map(
		(e) =>
			`| \`${e.method} ${e.path}\` | ${accessText(e.access)} | ${e.text} |`,
	).join("\n");

	return `# petri. — a guide for coding assistants

petri. (${publicUrl}) is a personal lab for trying out apps. Read this
page in full before you start; it is short.

## Words

- An **experiment** is one idea, with a number (EXP-007), a description
  and the owner's notes. The API calls it a **project**.
- A **culture** is one running version of an experiment, built from Git
  or a ZIP archive, at its own address. The API calls it a
  **deployment**. An experiment grows many cultures.
- The **gallery** (${publicUrl}) shows the experiments the owner chose,
  publicly.

Talk to your user in petri.'s words (experiment, culture); call the API
by its own (project, deployment).

## 1. Get access

You need an API key. Ask for one, and let the owner grant it:

\`\`\`sh
curl -X POST ${api}/access-requests \\
  -H 'content-type: application/json' \\
  -d '{"name": "<you> on <machine>", "scopes": ["deploy:read", "deploy:create", "deploy:update"], "reason": "<what for>"}'
\`\`\`

The answer holds \`userCode\`, \`reviewUrl\`, \`pollToken\`, \`expiresAt\`
(15 minutes) and \`interval\` (seconds).

1. Show your user the **code and the link**, and ask them to grant the
   request there. Never show the poll token.
2. Every \`interval\` seconds, \`POST ${api}/access-requests/token\` with
   \`{"pollToken": "..."}\`. It answers \`{"status": "pending"}\` until
   the owner decides, then \`denied\`, \`expired\`, or \`granted\` with
   the key in \`key\`. Polling faster answers 429 \`slow_down\`.
3. The key is given out **once**. Keep it where your user's secrets
   live (an environment variable, a credentials file outside the
   repository); never print it, commit it or put it in a culture.
   Send it as \`Authorization: Bearer <key>\`.

Ask only for the scopes you need. \`deploy:delete\` is rarely needed;
the owner may grant fewer scopes than you asked for.

## 2. Grow a culture

The app needs a **Dockerfile** and must answer HTTP on one port, on all
interfaces (\`0.0.0.0\`), not only localhost. The port comes from
\`EXPOSE\` in the Dockerfile, or set \`build.port\`. Any HTTP answer below
500 counts as healthy, if it comes within the health-check time (see
the settings).

Replace the \`<…>\` placeholders. From a public Git repository
(HTTPS):

\`\`\`sh
curl -X POST ${api}/deployments \\
  -H "Authorization: Bearer $PETRI_KEY" -H 'content-type: application/json' \\
  -d '{"project": "<experiment-slug>", "name": "<culture-name>",
       "source": {"type": "git", "repository": "<https-repository-url>", "ref": "<branch, tag or commit>"}}'
\`\`\`

From local files, as a ZIP archive:

\`\`\`sh
curl -X POST ${api}/deployments/upload \\
  -H "Authorization: Bearer $PETRI_KEY" \\
  -F 'settings={"project": "<experiment-slug>", "name": "<culture-name>"}' \\
  -F 'archive=@<archive.zip>'
\`\`\`

- \`project\` is the experiment's slug (lower case, digits, dashes). A
  new slug starts a new experiment; reuse it for new versions of the
  same idea. List experiments first (\`GET ${api}/projects\`).
- \`name\` tells cultures apart (defaults to the Git ref, or "upload").
- \`source.directory\` (Git) or \`directory\` (ZIP): where the
  Dockerfile is, if not at the top.
- \`lifecycle\` defaults to temporary, ${TTL_HOURS.default} hours
  (\`{"mode": "temporary", "ttlHours": 72}\`, at most ${TTL_HOURS.max}).
  Use \`{"mode": "permanent"}\` only if your user asks.
- A temporary culture **expires** at \`expiresAt\`: its app is removed
  and its status becomes \`expired\`; the history stays. To keep it
  longer, extend it, counted from now:

  \`\`\`sh
  curl -X PATCH ${api}/deployments/<id> \\
    -H "Authorization: Bearer $PETRI_KEY" -H 'content-type: application/json' \\
    -d '{"lifecycle": {"mode": "temporary", "ttlHours": 48}}'
  \`\`\`

  A redeploy grows an expired culture again, for another
  ${TTL_HOURS.default} hours.
- \`build.args\` are stored in the image: never put secrets there.
- Check \`GET ${api}/settings\` before uploading: it lists the size,
  time and memory limits.

## 3. Follow it

Poll \`GET ${api}/deployments/<id>\` every few seconds (or follow
\`/events/stream\`). \`status\` goes \`queued\` → \`cloning\` →
\`building\` → \`deploying\` → \`health_check\` → \`ready\`, or ends in
\`failed\`. A build takes from seconds to a few minutes.

- **ready**: \`url\` is the address, by default
  \`${previewScheme}//<experiment-slug>-<culture-name>.${previewHost}\`. Give
  it to your user.
- **failed**: \`latestBuild.errorMessage\` says why; the build log
  (\`GET ${api}/deployments/<id>/logs\`) and the app's output
  (\`?source=runtime\`) say more. Fix the cause and redeploy (4).

## 4. Change it: push, redeploy, follow, look

A new version of the same app goes to the **same culture**, at the same
address; don't grow a new culture for each change.

1. **Push** your commit (Git), or zip the files again (ZIP).
2. **Redeploy**. Git: \`POST ${api}/deployments/<id>/redeploy\` fetches
   the ref again, so a branch picks up your new commits; send
   \`{"ref": "<branch, tag or commit>"}\` to build another one from now
   on. ZIP: send the new archive:

   \`\`\`sh
   curl -X POST ${api}/deployments/<id>/upload \\
     -H "Authorization: Bearer $PETRI_KEY" -F 'archive=@<archive.zip>'
   \`\`\`

3. **Follow** \`latestBuild\` in \`GET ${api}/deployments/<id>\`: it is
   the new build, \`queued\`, \`running\`, then \`succeeded\` or
   \`failed\` (with \`errorMessage\`; its log is
   \`/logs?build=<latestBuild.id>\`). A **ready** culture stays
   \`ready\` meanwhile: the old version keeps answering until the new
   one passes its health check, and keeps running if it fails. A
   culture that was stopped, failed or expired goes through the statuses
   of section 3 instead.
4. **Look** at \`url\` again: same address, new version.

One build at a time: a redeploy while one is queued or running answers
409. \`GET ${api}/deployments/<id>/builds\` lists them all.

## Ground rules

- Every culture's address can be **opened by anyone who knows it**.
  Don't deploy secrets, private data or anything that must not be
  public.
- Apps can reach the public internet, not the owner's network.
- Delete or stop only cultures you created in this session, unless your
  user asks otherwise.
- The gallery and an experiment's featured culture are the owner's
  choice: don't change visibility or \`featuredDeploymentId\` unless your
  user asks.
- Errors come as \`{"error": {"code", "message", "details", "help"}}\`.
  401: no or a bad key (\`help\` links to this guide); 403: the key
  lacks a scope (say which to your user); 429: wait and retry.

## Endpoints

| Endpoint | Access | What |
| --- | --- | --- |
${table}

The full reference, with every field: ${api}/docs (OpenAPI:
${api}/docs/json).
`;
}
