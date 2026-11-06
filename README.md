# petri.

A little lab for big ideas: a self-hosted platform for publishing
application previews and experiments from Git repositories or ZIP
uploads.

> **Status:** early development. Nothing is usable yet.

- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Development plan: [`docs/plan.md`](docs/plan.md)

## Development

Requirements:

- Node.js 24 (see `.nvmrc`)
- pnpm, via corepack: `corepack enable pnpm`
- Docker Engine with the Compose plugin

Setup:

```bash
pnpm install
cp .env.example .env    # local configuration, see comments inside
pnpm dev:infra          # start PostgreSQL in Docker
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
