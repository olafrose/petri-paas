# petri.

A little lab for big ideas: a self-hosted platform for publishing
application previews and experiments from Git repositories or ZIP
uploads.

> **Status:** early development. Nothing is usable yet.

- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Development plan: [`docs/plan.md`](docs/plan.md)
- Operations: [`docs/operations.md`](docs/operations.md)

## Development

Requirements:

- Node.js 24 (see `.nvmrc`)
- pnpm, via corepack: `corepack enable pnpm`
- Docker Engine with the Compose plugin

Setup:

```bash
pnpm install
cp .env.example .env    # local configuration, see comments inside
pnpm dev:infra          # start PostgreSQL, BuildKit and the edge proxy in Docker
scripts/install-buildctl.sh  # BuildKit client for builds and tests
pnpm dev:check-db       # confirm the configured database is reachable
```

Commands:

| Command          | Purpose                                  |
| ---------------- | ---------------------------------------- |
| `pnpm check`     | Lint and format check (Biome)            |
| `pnpm format`    | Apply lint fixes and formatting          |
| `pnpm typecheck` | Type-check all packages                  |
| `pnpm test`      | Run tests (Vitest)                       |
| `pnpm build`     | Build all packages                       |
| `pnpm dev:infra` | Start local services (Docker Compose)    |
| `pnpm dev:infra:down` | Stop local services                 |
| `pnpm dev:check-db` | Check the database connection         |
| `pnpm test:integration` | Run integration tests (needs PostgreSQL) |
| `pnpm db:generate` | Generate a SQL migration after changing the schema |
| `pnpm db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `pnpm dev:api`   | Run the API with reload on change (port 4000) |
| `pnpm dev:worker` | Run the background worker with reload on change |
| `pnpm dev:web`   | Run the web app (gallery and admin panel, port 3000) |

The web app forwards `/api/v1/*` to the API (`API_INTERNAL_URL`, default
`http://localhost:4000`), so the browser only ever talks to one origin.
Open <http://localhost:3000> for the gallery and `/admin` for the admin
panel.

The API applies database migrations on startup; start it before the
worker on a fresh database.

Previews are served by the edge proxy: a ready deployment answers at
`http://<subdomain>.app.localhost:8088` (its `url` in the API). The
worker routes it once its health check passes, and restores all routes
when it starts and every 30 seconds, so a restarted edge proxy recovers
by itself.

## Running the full stack in containers

For the production host, follow [`docs/operations.md`](docs/operations.md)
(firewall, images from GHCR, NPM, DNS, certificate, upgrades). To try the
stack locally, built from this checkout:

```bash
cp .env.example .env    # set POSTGRES_PASSWORD, AUTH_SECRET, PUBLIC_URL, PREVIEW_BASE_URL
docker compose up -d --build
docker compose exec api node dist/cli/set-owner.js --email you@example.com
```

This builds the `api`, `worker` and `web` images from
`infrastructure/docker/Dockerfile` and starts them with PostgreSQL. Only
the web app (`WEB_BIND:WEB_PORT`, default `127.0.0.1:3000`) and the edge
proxy for previews (`EDGE_BIND:EDGE_PORT`, default `127.0.0.1:8080`) are
published; the API and database stay on the internal network.
Containers run as an unprivileged user with read-only file systems.

## Egress filtering

Apps and builds may reach the public internet, but nothing private: not
the LAN, not the host, not cloud metadata, not other deployments. The
rules are in `infrastructure/firewall/petri.nft`; install them on every
petri. host before anything is public:

```bash
sudo apt install nftables
sudo scripts/install-firewall.sh   # loaded before Docker on every boot
scripts/probe-egress.sh            # checks what apps and builds can reach
```

The probe exits non-zero if something private is reachable. Add
listening machines from your LAN that must stay unreachable, e.g. the
router and NPM's admin UI: `PROBE_LAN_TARGETS="192.168.0.1 80,192.168.0.5 81"`.
On the production stack, point it at its build network:
`PROBE_BUILD_NETWORK=petri_build`. Docker requires the firewall once it
is installed: if the rules can't be loaded, Docker doesn't start.

## Authentication

The admin panel has a single owner and no sign-up. Create the owner, or
set a new password (which also signs out all sessions):

```bash
pnpm owner:set --email you@example.com --name "Your Name"
```

The password is prompted for (hidden), or read from stdin when piped.

Access to the API:

| Who                  | How                                              | Can use                         |
| -------------------- | ------------------------------------------------ | ------------------------------- |
| Anyone               | —                                                | health, sign-in, API docs       |
| The owner            | session cookie from signing in                   | everything                      |
| Coding assistants    | `Authorization: Bearer petri_…` (API key)        | routes allowed by the key's scopes |

API keys are created by the owner (`POST /api/v1/api-keys`) with the
scopes `deploy:read`, `deploy:create`, `deploy:update` and
`deploy:delete`. Keys cannot manage keys.

Sign-in through an OpenID Connect provider such as Authentik can be
enabled later with the `OIDC_*` variables in `.env.example`.

## API documentation

With the API running, the interactive API documentation is at
<http://localhost:4000/api/v1/docs> and the OpenAPI document at
`/api/v1/docs/json`.

Integration tests (`*.int.test.ts`) create a temporary database on the
server in `TEST_DATABASE_URL` (default: the dev database), and drop it
afterwards.

The database schema lives in `packages/database/src/schema.ts`. After
changing it, run `pnpm db:generate` and commit the generated migration;
CI fails if the two are out of sync.

Workspace packages are used directly from their TypeScript sources in
development (the `@petri/source` export condition), and from compiled
`dist/` output in production builds.

## License

[AGPL-3.0-or-later](LICENSE)
