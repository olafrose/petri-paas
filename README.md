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
```

Commands:

| Command          | Purpose                                  |
| ---------------- | ---------------------------------------- |
| `pnpm check`     | Lint and format check (Biome)            |
| `pnpm format`    | Apply lint fixes and formatting          |
| `pnpm typecheck` | Type-check all packages                  |
| `pnpm test`      | Run tests (Vitest)                       |
| `pnpm build`     | Build all packages                       |

## License

[AGPL-3.0-or-later](LICENSE)
