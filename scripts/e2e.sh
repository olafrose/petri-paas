#!/bin/sh
# Runs the end-to-end tests (e2e/) against the whole stack:
#   pnpm test:e2e [playwright options, e.g. a test file or --headed]
#
# Needs the services from `pnpm dev:infra` (or CI's). Starts the API, the
# worker and the built web app on spare ports with a throwaway database,
# creates the owner, runs Playwright, and removes everything afterwards.
# Don't run your own dev worker at the same time: both would manage the
# edge proxy's routes.
#
# The browser: in Playwright's Docker image by default, so nothing needs
# installing; E2E_BROWSER=local uses one installed with
# `pnpm exec playwright install --with-deps chromium` (CI does that).
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.65.0-noble
API_PORT=${E2E_API_PORT:-4300}
WEB_PORT=${E2E_WEB_PORT:-3300}
SERVER_URL=${TEST_DATABASE_URL:-postgres://petri:petri@localhost:5432/petri}
DB_NAME="petri_e2e_$$"
DATABASE_URL=$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.toString())' "$SERVER_URL" "$DB_NAME")
WORK=$(mktemp -d)
export E2E_OWNER_EMAIL=owner@example.com
export E2E_OWNER_PASSWORD="e2e-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
pids=""

sql() { # statement, against the server's default database
	node -e '
		const pg = require("pg");
		const client = new pg.Client({ connectionString: process.argv[1] });
		client.connect().then(() => client.query(process.argv[2])).then(() => client.end(),
			(error) => { console.error(error.message); process.exit(1); });
	' "$SERVER_URL" "$1"
}

kill_tree() { # pid: the process and everything it started
	for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
	kill "$1" 2>/dev/null || true
}

# What this run's deployments left behind, e.g. after a failed test: their
# routes, containers, networks (the edge proxy taken off first), images.
remove_apps() {
	ids=$(node -e '
		const pg = require("pg");
		const client = new pg.Client({ connectionString: process.argv[1] });
		client.connect()
			.then(() => client.query("select id from deployments"))
			.then((result) => { for (const row of result.rows) console.log(row.id); return client.end(); })
			.catch(() => process.exit(0));
	' "$DATABASE_URL")
	socket=${EDGE_ADMIN_SOCKET:-$repo/.tools/edge/admin.sock}
	for id in $ids; do
		curl -s -o /dev/null -X DELETE --unix-socket "$socket" \
			"http://localhost/id/petri-route-$id" || true
		docker rm -f "petri-$id" >/dev/null 2>&1 || true
		docker network disconnect -f "petri-$id" "${EDGE_CONTAINER:-petri-dev-edge-1}" >/dev/null 2>&1 || true
		docker network rm "petri-$id" >/dev/null 2>&1 || true
		images=$(docker images -q "petri/$id")
		[ -z "$images" ] || docker rmi -f $images >/dev/null 2>&1 || true
	done
}

cleanup() {
	status=$?
	for pid in $pids; do kill_tree "$pid"; done
	sleep 1
	remove_apps
	sql "drop database if exists \"$DB_NAME\" with (force)" || true
	if [ "$status" != 0 ]; then
		echo "--- last lines of the service logs (all in $WORK)"
		for log in api worker web; do
			echo "--- $log"
			tail -n 20 "$WORK/$log.log" 2>/dev/null || true
		done
	else
		rm -rf "$WORK"
	fi
	exit "$status"
}
trap cleanup EXIT INT TERM

wait_for() { # url, name
	for _ in $(seq 1 60); do
		curl -sf -o /dev/null "$1" && return 0
		sleep 1
	done
	echo "$2 did not start; see $WORK/$2.log" >&2
	exit 1
}

echo "Database $DB_NAME, API :$API_PORT, web :$WEB_PORT"
sql "create database \"$DB_NAME\""

# The same environment for API, worker and the owner command. Values from
# .env are overridden: these must match each other.
export NODE_ENV=test LOG_LEVEL=info DATABASE_URL API_PORT \
	PUBLIC_URL="http://localhost:$WEB_PORT" \
	AUTH_SECRET="e2e-secret-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" \
	UPLOADS_DIR="$WORK/uploads" LOGS_DIR="$WORK/logs" WORKSPACE_DIR="$WORK/ws"
node_run() { # dir, script and its arguments
	dir=$1
	shift
	(cd "$dir" && exec node --conditions=@petri/source "$@")
}

node_run apps/api src/main.ts >"$WORK/api.log" 2>&1 &
pids="$pids $!"
wait_for "http://localhost:$API_PORT/api/v1/health" api
printf '%s\n' "$E2E_OWNER_PASSWORD" |
	node_run apps/api src/cli/set-owner.ts --email "$E2E_OWNER_EMAIL" --name Owner
node_run apps/worker src/main.ts >"$WORK/worker.log" 2>&1 &
pids="$pids $!"

# The web app's /api/v1 forwarding target is fixed when it's built. Next.js
# runs directly (not through pnpm), so $! is the server itself, and with
# its own NODE_ENV.
next_run() {
	(cd apps/web && exec env -u NODE_ENV API_INTERNAL_URL="http://localhost:$API_PORT" \
		node node_modules/next/dist/bin/next "$@")
}
echo "Building the web app..."
next_run build >"$WORK/build.log" 2>&1 ||
	{ tail -n 30 "$WORK/build.log"; exit 1; }
next_run start --port "$WEB_PORT" >"$WORK/web.log" 2>&1 &
pids="$pids $!"
wait_for "http://localhost:$WEB_PORT/login" web

export E2E_BASE_URL="http://localhost:$WEB_PORT"
if [ "${E2E_BROWSER:-docker}" = local ]; then
	(cd e2e && pnpm exec playwright test "$@")
else
	docker run --rm --network host --ipc host \
		--user "$(id -u):$(id -g)" -e HOME=/tmp \
		-e E2E_BASE_URL -e E2E_OWNER_EMAIL -e E2E_OWNER_PASSWORD \
		-v "$repo:$repo" -w "$repo/e2e" "$PLAYWRIGHT_IMAGE" \
		../node_modules/.bin/playwright test "$@"
fi
